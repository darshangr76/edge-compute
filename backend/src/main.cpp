// ============================================================
// Edge Compute - Spatial Agent C++ WebSocket Bridge
// Working version: qwen2.5:7b only (keep_alive=-1 + warmup)
// ============================================================
#include <iostream>
#include <string>
#include <fstream>
#include <sstream>
#include <chrono>
#include <ctime>
#include <atomic>
#include <future>
#include <deque>
#include <vector>
#include <mutex>
#include <thread>
#include <cctype>
#include "httplib.h"
#include "json.hpp"

using json = nlohmann::json;
using namespace httplib;

static std::string read_file(const std::string& path) {
    std::ifstream f(path);
    std::stringstream ss;
    ss << f.rdbuf();
    return ss.str();
}

std::string g_grammar;
std::string g_system_prompt;

std::atomic<int> g_request_count{0};
std::atomic<long> g_total_latency_ms{0};

// --- SCENE STATE MEMORY ---
struct SceneObject {
    int id;
    std::string kind;
    std::string color;
    double x, y, z;
};

std::vector<SceneObject> g_scene;
std::mutex g_scene_mutex;
int g_next_object_id = 1;

std::string build_scene_context() {
    std::lock_guard<std::mutex> lock(g_scene_mutex);
    if (g_scene.empty()) return "Scene is empty.";
    std::string ctx = "Current scene objects:\n";
    for (const auto& obj : g_scene) {
        ctx += "- " + obj.kind + " (" + obj.color + ") at ("
             + std::to_string((int)obj.x) + ", "
             + std::to_string((int)obj.y) + ", "
             + std::to_string((int)obj.z) + ")\n";
    }
    return ctx;
}

void update_scene_from_action(const json& payload) {
    std::lock_guard<std::mutex> lock(g_scene_mutex);
    std::string verb = payload.value("action", "");
    
    if (verb == "spawn") {
        SceneObject obj;
        obj.id = g_next_object_id++;
        obj.kind = payload.value("object", "cube");
        obj.color = payload["params"].value("color", "#ffffff");
        auto pos = payload["params"].value("position", json::array({0, 1.2, -1.5}));
        obj.x = pos[0].get<double>();
        obj.y = pos[1].get<double>();
        obj.z = pos[2].get<double>();
        g_scene.push_back(obj);
    }     } else if (verb == "delete") {
        if (!g_scene.empty()) {
            // Check if the AI specified a color
            std::string target_color = payload["params"].value("color", "");
            
            if (!target_color.empty()) {
                // Find and delete the first matching color
                for (auto it = g_scene.begin(); it != g_scene.end(); ++it) {
                    if (it->color == target_color) {
                        g_scene.erase(it);
                        break;
                    }
                }
            } else {
                // If no color specified, just pop the last one (standard undo behavior)
                g_scene.pop_back();
            }
        }
    }


// --- UNDO STACK ---
std::deque<json> g_undo_stack;
std::mutex g_undo_mutex;

// --- HISTORY ---
std::deque<std::string> g_history;
std::mutex g_history_mutex;

std::string get_time_str() {
    std::time_t t = std::time(nullptr);
    char ts[32];
    std::strftime(ts, sizeof(ts), "%H:%M:%S", std::localtime(&t));
    return std::string(ts);
}

// --- PREPROCESSING (word-boundary aware) ---
std::string preprocess_text(const std::string& input) {
    std::string text = input;
    
    auto replace_word = [](std::string& s, const std::string& from, const std::string& to) {
        std::string result;
        size_t i = 0;
        while (i < s.length()) {
            if (s.compare(i, from.length(), from) == 0) {
                bool left_ok = (i == 0 || !std::isalpha((unsigned char)s[i - 1]));
                bool right_ok = (i + from.length() >= s.length() || !std::isalpha((unsigned char)s[i + from.length()]));
                if (left_ok && right_ok) {
                    result += to;
                    i += from.length();
                    continue;
                }
            }
            result += s[i];
            i++;
        }
        s = result;
    };
    
    replace_word(text, "spear", "sphere");
    replace_word(text, "speaker", "sphere");
    replace_word(text, "spare", "sphere");
    replace_word(text, "pawn", "spawn");
    replace_word(text, "pawned", "spawned");
    replace_word(text, "blew", "blue");
    replace_word(text, "beef", "blue");
    replace_word(text, "bull", "blue");
    replace_word(text, "grin", "green");
    replace_word(text, "reed", "red");
    replace_word(text, "read", "red");
    
    return text;
}

// --- TARGET HINT EXTRACTION ---
std::string extract_target_hint(const std::string& text) {
    std::string hint;
    if (text.find("red") != std::string::npos) hint += "red ";
    if (text.find("blue") != std::string::npos) hint += "blue ";
    if (text.find("green") != std::string::npos) hint += "green ";
    if (text.find("sphere") != std::string::npos) hint += "sphere ";
    if (text.find("cube") != std::string::npos) hint += "cube ";
    return hint;
}

// --- TEXT INFERENCE (qwen2.5:7b only) ---
std::string infer_ollama(const std::string& user_text) {
    httplib::Client cli("http://localhost:11434");
    cli.set_read_timeout(30, 0);

    std::string scene_ctx = build_scene_context();
    std::string target_hint = extract_target_hint(user_text);
    if (!target_hint.empty()) {
        scene_ctx += "\nUser is referring to: " + target_hint + "\n";
    }
    std::string history_str = "Recent commands:\n";
    {
        std::lock_guard<std::mutex> lock(g_history_mutex);
        for (const auto& h : g_history) history_str += "- " + h + "\n";
    }

    std::string final_prompt = scene_ctx + "\n" + history_str + "\nUser says: " + user_text;

    nlohmann::json req = {
        {"model", "qwen2.5:7b"},
        {"prompt", final_prompt},
        {"system", g_system_prompt},
        {"grammar", g_grammar},
        {"stream", false},
        {"keep_alive", -1},
        {"options", {{"num_predict", 1024}, {"temperature", 0}}}
    };
    auto res = cli.Post("/api/generate", req.dump(), "application/json");
    if (!res || res->status != 200) return R"({"action":"delete","object":"cube","params":{}})";
    try {
        auto body = nlohmann::json::parse(res->body);
        return body.value("response", std::string("{}"));
    } catch (...) { return R"({"action":"delete","object":"cube","params":{}})"; }
}

// --- VISION INFERENCE ---
std::string infer_vision(const std::string& prompt, const std::string& base64_image) {
    httplib::Client cli("http://localhost:11434");
    cli.set_read_timeout(120, 0);
    nlohmann::json req = {
        {"model", "qwen2.5vl:7b"},
        {"prompt", prompt},
        {"images", {base64_image}},
        {"system", g_system_prompt},
        {"grammar", g_grammar},
        {"stream", false},
        {"keep_alive", -1},
        {"options", {{"num_predict", 1024}, {"temperature", 0}}}
    };
    auto res = cli.Post("/api/generate", req.dump(), "application/json");
    
    std::cout << "[RAM] Reloading qwen2.5:7b..." << std::endl;
    httplib::Client warmup("http://localhost:11434");
    nlohmann::json warmup_req = {
        {"model", "qwen2.5:7b"},
        {"prompt", "ready"},
        {"stream", false},
        {"keep_alive", -1},
        {"options", {{"num_predict", 1}}}
    };
    warmup.Post("/api/generate", warmup_req.dump(), "application/json");
    std::cout << "[RAM] Text model reloaded." << std::endl;

    if (!res || res->status != 200) return R"({"action":"delete","object":"cube","params":{}})";
    try {
        auto body = nlohmann::json::parse(res->body);
        return body.value("response", std::string("{}"));
    } catch (...) { return R"({"action":"delete","object":"cube","params":{}})"; }
}

void handle_ws(const Request&, ws::WebSocket& ws) {
    std::string msg;
    while (ws.read(msg)) {
        std::string ts = get_time_str();
        std::cout << "[" << ts << "] recv: " << msg.substr(0, 120) << (msg.size() > 120 ? "...(truncated)" : "") << std::endl;

        json in;
        try { in = json::parse(msg); }
        catch (...) { ws.send(R"({"type":"error","message":"bad json"})"); continue; }

        if (in.value("type","") != "command") continue;

        std::string text = in.value("text","");
        std::string id = in.value("id","");
        std::string image = in.value("image","");

        std::string processed_text = preprocess_text(text);
        if (processed_text != text) {
            std::cout << "[" << ts << "] [Preprocess] \"" << text << "\" -> \"" << processed_text << "\"" << std::endl;
        }

        if (processed_text == "explain" || processed_text == "what happened" || processed_text == "what just happened") {
            std::lock_guard<std::mutex> lock(g_history_mutex);
            std::string explanation = "Last " + std::to_string(g_history.size()) + " commands:\n";
            int i = 1;
            for (const auto& h : g_history) {
                explanation += std::to_string(i++) + ". " + h + "\n";
            }
            ws.send(json{{"type","explain"},{"id",id},{"text",explanation}}.dump());
            continue;
        }

        if (processed_text == "undo" || processed_text == "undo that") {
            json inverse;
            {
                std::lock_guard<std::mutex> lock(g_undo_mutex);
                if (!g_undo_stack.empty()) {
                    inverse = g_undo_stack.back();
                    g_undo_stack.pop_back();
                }
            }
            if (inverse.is_null()) {
                ws.send(json{{"type","action"},{"id",id},{"payload",{{"action","delete"},{"object","cube"},{"params",json::object()}}},{"vision",false}}.dump());
            } else if (inverse.contains("plan") && inverse["plan"].is_array()) {
                std::cout << "[" << ts << "] [Undo] Reverting " << inverse["plan"].size() << " steps" << std::endl;
                for (const auto& step : inverse["plan"]) {
                    json act = step["action"];
                    update_scene_from_action(act);
                    json out = {{"type","action"},{"id",id + "-u" + std::to_string(step["step"].get<int>())},{"payload",act},{"vision",false}};
                    ws.send(out.dump());
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));
                }
            } else {
                update_scene_from_action(inverse);
                ws.send(json{{"type","action"},{"id",id},{"payload",inverse},{"vision",false}}.dump());
            }
            continue;
        }

        auto start = std::chrono::high_resolution_clock::now();

        if (!image.empty()) {
            std::cout << "[" << ts << "] [LLM] Vision request..." << std::endl;
        } else {
            std::cout << "[" << ts << "] [LLM] Text request: \"" << processed_text << "\"" << std::endl;
        }

        auto future = std::async(std::launch::async, [processed_text, image]() {
            return image.empty() ? infer_ollama(processed_text) : infer_vision(processed_text, image);
        });
        std::string action_str = future.get();
        
        auto end = std::chrono::high_resolution_clock::now();
        auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(end - start).count();
        std::cout << "[" << ts << "] [Latency] Inference took " << ms << " ms" << std::endl;

        // Strip markdown
        if (action_str.find("```") != std::string::npos) {
            size_t md_start = action_str.find("```");
            size_t md_end = action_str.find("```", md_start + 3);
            if (md_end != std::string::npos) {
                size_t newline_after_start = action_str.find('\n', md_start);
                if (newline_after_start != std::string::npos && newline_after_start < md_end) {
                    action_str = action_str.substr(newline_after_start + 1, md_end - newline_after_start - 1);
                } else {
                    action_str = action_str.substr(md_start + 3, md_end - md_start - 3);
                }
            }
        }
        action_str.erase(0, action_str.find_first_not_of(" \t\n\r`"));
        if (!action_str.empty()) {
            action_str.erase(action_str.find_last_not_of(" \t\n\r`") + 1);
        }

        g_request_count++;
        g_total_latency_ms += ms;

        {
            std::lock_guard<std::mutex> lock(g_history_mutex);
            g_history.push_back("User: " + processed_text + " -> " + action_str);
            while (g_history.size() > 3) g_history.pop_front();
        }

        int cnt = g_request_count.load();
        long avg = cnt > 0 ? (g_total_latency_ms.load() / cnt) : 0;
        std::cout << "[" << ts << "] [Stats] Total: " << cnt << " | Avg: " << avg << " ms | Memory: " << g_history.size() << " items" << std::endl;
        std::cout << "[" << ts << "] [DEBUG] Raw LLM: " << action_str.substr(0, 400) << std::endl;
        
            try {
            // --- EMERGENCY FIX: STRIP BROKEN TRAILING JSON ---
                        // The LLM appends explanation outside the plan object.
            // We need to extract the plan array and ignore the rest.
            if (action_str.find("\"plan\"") != std::string::npos) {
                size_t plan_start = action_str.find("\"plan\":");
                size_t plan_end = action_str.find("]}", plan_start);
                if (plan_start != std::string::npos && plan_end != std::string::npos) {
                    // Reconstruct valid JSON: {"plan": [...]}
                    std::string plan_only = action_str.substr(plan_start, plan_end - plan_start + 2);
                    action_str = "{" + plan_only + "}";
                }
            }

            json payload = json::parse(action_str);
            
            if (payload.contains("plan") && payload["plan"].is_array()) {
                int total_steps = payload["plan"].size();
                std::cout << "[" << ts << "] [Plan] Executing " << total_steps << " steps..." << std::endl;
                
                int step_index = 0;
                for (const auto& step : payload["plan"]) {
                    step_index++;
                    json act = step["action"];
                    update_scene_from_action(act);
                    
                    json out = {
                        {"type", "action"},
                        {"id", id + "-s" + std::to_string(step["step"].get<int>())},
                        {"payload", act},
                        {"vision", false},
                        {"stream_step", step_index},
                        {"stream_total", total_steps}
                    };
                    std::cout << "[" << ts << "] [Plan] Step " << step_index << "/" << total_steps 
                              << " -> " << act["action"] << std::endl;
                    ws.send(out.dump());
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));
                }
                std::cout << "[" << ts << "] [Plan] Complete." << std::endl;
                
                json revert_plan = {{"plan", json::array()}};
                for (const auto& step : payload["plan"]) {
                    json act = step["action"];
                    std::string verb = act.value("action", "");
                    json inverse;
                    if (verb == "spawn") {
                        inverse = {{"action","delete"},{"object",act["object"]},{"params",json::object()}};
                    } else if (verb == "scale") {
                        double f = act["params"].value("factor", 1.5);
                        inverse = {{"action","scale"},{"object",act["object"]},{"params",{{"factor", 1.0/f}}}};
                    } else if (verb == "move" && act["params"].contains("delta")) {
                        auto d = act["params"]["delta"];
                        inverse = {{"action","move"},{"object",act["object"]},{"params",{{"delta", {-d[0].get<double>(), -d[1].get<double>(), -d[2].get<double>()}}}}};
                    }
                    if (!inverse.is_null()) {
                        revert_plan["plan"].push_back({{"step", step["step"]}, {"action", inverse}});
                    }
                }
                if (!revert_plan["plan"].empty()) {
                    std::lock_guard<std::mutex> lock(g_undo_mutex);
                    g_undo_stack.push_back(revert_plan);
                    if (g_undo_stack.size() > 5) g_undo_stack.pop_front();
                    std::cout << "[" << ts << "] [Undo] Plan saved (" << revert_plan["plan"].size() << " steps)" << std::endl;
                }
            }
            else {
                // --- SINGLE ACTION LOGIC ---
                update_scene_from_action(payload);
                
                json inverse;
                if (payload["action"] == "spawn") {
                    inverse = {{"action","delete"},{"object",payload["object"]},{"params",json::object()}};
                } else if (payload["action"] == "scale") {
                    double f = payload["params"].value("factor", 1.5);
                    inverse = {{"action","scale"},{"object","cube"},{"params",{{"factor", 1.0/f}}}};
                }
                if (!inverse.is_null()) {
                    std::lock_guard<std::mutex> lock(g_undo_mutex);
                    g_undo_stack.push_back(inverse);
                    if (g_undo_stack.size() > 5) g_undo_stack.pop_front();
                }
                
                std::string explanation = payload.value("explanation", "");
                std::string suggestion = payload.value("suggestion", "");
                
                if (explanation.empty()) {
                    std::string verb = payload.value("action", "action");
                    std::string obj = payload.value("object", "object");
                    explanation = "I " + verb + "ed the " + obj + ".";
                }
                if (suggestion.empty()) {
                    std::string verb = payload.value("action", "");
                    if (verb == "spawn") suggestion = "Would you like to scale it or change its color?";
                    else if (verb == "scale") suggestion = "Would you like to spawn another object?";
                    else if (verb == "color") suggestion = "Would you like to adjust the size?";
                    else suggestion = "What would you like to do next?";
                }
                
                std::cout << "[" << ts << "] [Explain] " << explanation << std::endl;
                std::cout << "[" << ts << "] [Suggest] " << suggestion << std::endl;
                
                json out = {
                    {"type","action"},
                    {"id",id},
                    {"payload",payload},
                    {"vision", !image.empty()},
                    {"explanation", explanation},
                    {"suggestion", suggestion}
                };
                ws.send(out.dump());
            }
        } catch (const std::exception& e) {
            std::cerr << "[" << ts << "] ERROR: bad LLM JSON: " << e.what() << std::endl;
            ws.send(R"({"type":"error","message":"LLM returned invalid JSON"})");
        }
              

void handle_stats(const Request&, Response& res) {
    int count = g_request_count.load();
    long total = g_total_latency_ms.load();
    long avg = count > 0 ? (total / count) : 0;
    int memory = 0;
    { std::lock_guard<std::mutex> lock(g_history_mutex); memory = g_history.size(); }
    res.set_content(json{{"total_requests", count},{"total_latency_ms", total},{"avg_latency_ms", avg},{"memory_items", memory}}.dump(), "application/json");
}

void handle_scene(const Request&, Response& res) {
    std::lock_guard<std::mutex> lock(g_scene_mutex);
    json scene = json::array();
    for (const auto& obj : g_scene) {
        scene.push_back({{"id", obj.id}, {"kind", obj.kind}, {"color", obj.color}, {"position", {obj.x, obj.y, obj.z}}});
    }
    res.set_content(scene.dump(), "application/json");
}

int main() {
    g_grammar = read_file("grammars/action.gbnf");
    g_system_prompt = read_file("grammars/system_prompt.txt");
    if (g_grammar.empty() || g_system_prompt.empty()) {
        std::cerr << "Failed to load grammar or system prompt" << std::endl;
        return 1;
    }

    // Warmup
    std::cout << "Warming up qwen2.5:7b..." << std::endl;
    {
        httplib::Client warmup_cli("http://localhost:11434");
        warmup_cli.set_read_timeout(60, 0);
        nlohmann::json warmup_req = {
            {"model", "qwen2.5:7b"},
            {"prompt", "spawn a red cube"},
            {"system", g_system_prompt},
            {"grammar", g_grammar},
            {"stream", false},
            {"keep_alive", -1},
            {"options", {{"num_predict", 50}, {"temperature", 0}}}
        };
        auto res = warmup_cli.Post("/api/generate", warmup_req.dump(), "application/json");
        if (res && res->status == 200) {
            std::cout << "Model loaded and locked in RAM." << std::endl;
        }
    }

    Server svr;
    svr.set_default_headers({
        {"Access-Control-Allow-Origin", "*"},
        {"Access-Control-Allow-Methods", "GET, POST, OPTIONS"},
        {"Access-Control-Allow-Headers", "Content-Type"}
    });

    svr.Get("/health", handle_health);
    svr.Get("/stats", handle_stats);
    svr.Get("/scene", handle_scene);
    svr.WebSocket("/ws", handle_ws);

    std::cout << "==========================================" << std::endl;
    std::cout << " Edge Compute - Engine (qwen2.5:7b)" << std::endl;
    std::cout << " Listening on :9001" << std::endl;
    std::cout << "==========================================" << std::endl;

    if (!svr.listen("0.0.0.0", 9001)) return 1;
    return 0;
}