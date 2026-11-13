import * as THREE from 'three';

// ============================================================
// CONFIG
// ============================================================
const WS_URL = `ws://${window.location.hostname}:9001/ws`;
const STATS_URL = `http://${window.location.hostname}:9001/stats`;
const SCENE_URL = `http://${window.location.hostname}:9001/scene`;

// ============================================================
// THREE.JS SCENE
// ============================================================
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x111122);
scene.fog = new THREE.FogExp2(0x111122, 0.03);

const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1.6, 3);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(devicePixelRatio);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
// 1. Better Lighting for Depth and Shadows
const ambientLight = new THREE.AmbientLight(0x404060, 1.5); // Soft ambient blue
scene.add(ambientLight);

const dirLight = new THREE.DirectionalLight(0xffffff, 2);
dirLight.position.set(2, 5, 2);
dirLight.castShadow = true;
scene.add(dirLight);

const rimLight = new THREE.DirectionalLight(0x00c8ff, 1.5); // Neon rim light
rimLight.position.set(-2, 1, -2);
scene.add(rimLight);

// 2. Ground Plane (to catch shadows and give depth)
const planeGeom = new THREE.PlaneGeometry(20, 20);
const planeMat = new THREE.MeshStandardMaterial({ 
    color: 0x050510, 
    roughness: 0.8, 
    metalness: 0.2 
});
const groundPlane = new THREE.Mesh(planeGeom, planeMat);
groundPlane.rotation.x = -Math.PI / 2;
groundPlane.position.y = 0;
groundPlane.receiveShadow = true;
scene.add(groundPlane);

// 3. The Grid (slightly raised above the plane)
const grid = new THREE.GridHelper(20, 40, 0x00c8ff, 0x112233);
grid.position.y = 0.01;
scene.add(grid);
// ============================================================
// VR FLOATING BUTTONS (grouped — hidden in 2D mode)
// ============================================================
const vrButtonGroup = new THREE.Group();
vrButtonGroup.visible = false;
scene.add(vrButtonGroup);

const vrButtons = [];

function createVRButton(label, command, position, color) {
  const geom = new THREE.BoxGeometry(0.4, 0.1, 0.02);
  const mat = new THREE.MeshStandardMaterial({
    color: color,
    emissive: color,
    emissiveIntensity: 0.5,
    roughness: 0.3
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.userData.command = command;
  mesh.userData.isVRButton = true;
  mesh.userData.originalColor = color;
  vrButtonGroup.add(mesh);
  vrButtons.push(mesh);

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(0,0,0,0.9)';
  ctx.fillRect(0, 0, 512, 128);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 48px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 256, 64);

  const textTex = new THREE.CanvasTexture(canvas);
  const textGeom = new THREE.PlaneGeometry(0.38, 0.09);
  const textMat = new THREE.MeshBasicMaterial({ map: textTex, transparent: true });
  const textMesh = new THREE.Mesh(textGeom, textMat);
  textMesh.position.set(position[0], position[1], position[2] + 0.012);
  vrButtonGroup.add(textMesh);

  return mesh;
}

const buttonPanel = [
  { label: 'SPAWN RED',  cmd: 'spawn a red cube',           color: 0xff3366 },
  { label: 'BIGGER',     cmd: 'make it bigger',             color: 0x33ff66 },
  { label: 'BLUE',       cmd: 'make it blue',               color: 0x3388ff },
  { label: 'DELETE',     cmd: 'delete it',                  color: 0xff6633 },
  { label: 'SPAWN 3',    cmd: 'spawn three cubes',          color: 0xffcc00 },
  { label: 'VISION',     cmd: '__VISION__',                 color: 0xff00ff },
];

const panelStartX = -0.6;
const panelStartY = 1.6;
const panelZ = -1.8;

buttonPanel.forEach((btn, i) => {
  const row = Math.floor(i / 2);
  const col = i % 2;
  createVRButton(
    btn.label,
    btn.cmd,
    [panelStartX + col * 0.5, panelStartY - row * 0.16, panelZ],
    btn.color
  );
});
console.log(`[VR] Created ${vrButtons.length} VR buttons (hidden in 2D mode)`);

// ============================================================
// VR CLICK DETECTION (hands + controllers)
// ============================================================
function triggerButton(btn) {
  const now = performance.now();
  if (!btn.userData.lastClick || now - btn.userData.lastClick > 500) {
    btn.userData.lastClick = now;
    btn.material.emissiveIntensity = 1.5;
    setTimeout(() => { btn.material.emissiveIntensity = 0.5; }, 200);
    console.log(`[VR] Button pressed: ${btn.userData.command}`);

    if (btn.userData.command === '__VISION__') {
      const vb = document.getElementById('vision-btn');
      if (vb) vb.click();
    } else {
      sendCommand(btn.userData.command);
    }
  }
}

function testButtonHit(position) {
  for (const btn of vrButtons) {
    const worldPos = new THREE.Vector3();
    btn.getWorldPosition(worldPos);
    if (position.distanceTo(worldPos) < 0.15) {
      triggerButton(btn);
    }
  }
}

function testRayHit(origin, direction) {
  for (const btn of vrButtons) {
    const worldPos = new THREE.Vector3();
    btn.getWorldPosition(worldPos);
    
    const toBtn = worldPos.clone().sub(origin);
    const projection = toBtn.dot(direction);
    
    if (projection > 0 && projection < 3) {
      const closestPoint = origin.clone().add(direction.clone().multiplyScalar(projection));
      if (closestPoint.distanceTo(worldPos) < 0.15) {
        triggerButton(btn);
      }
    }
  }
}

function checkVRButtonClicks(frame) {
  if (!renderer.xr.isPresenting || !frame) return;
  const session = renderer.xr.getSession();
  if (!session) return;
  
  const refSpace = renderer.xr.getReferenceSpace();
  
  for (const src of session.inputSources) {
    // Hands
    if (src.hand) {
      const tipJoint = src.hand.get('index-finger-tip');
      if (tipJoint) {
        const pose = frame.getJointPose(tipJoint, refSpace);
        if (pose) {
          const tipPos = new THREE.Vector3().copy(pose.transform.position);
          testButtonHit(tipPos);
        }
      }
    }
    
    // Controllers
    if (src.targetRaySpace) {
      const rayPose = frame.getPose(src.targetRaySpace, refSpace);
      if (rayPose) {
        const origin = new THREE.Vector3().copy(rayPose.transform.position);
        const quat = new THREE.Quaternion().copy(rayPose.transform.orientation);
        const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
        
        if (!src._laser) {
          const laserGeom = new THREE.BufferGeometry().setFromPoints([origin, origin.clone().add(direction.clone().multiplyScalar(3))]);
          const laserMat = new THREE.LineBasicMaterial({ color: 0xff0000, linewidth: 2 });
          src._laser = new THREE.Line(laserGeom, laserMat);
          scene.add(src._laser);
        }
        
        const laserEnd = origin.clone().add(direction.clone().multiplyScalar(3));
        src._laser.geometry.setFromPoints([origin, laserEnd]);
        
        testRayHit(origin, direction);
      }
    }
  }
}

// ============================================================
// HAND TRACKING VISUALS
// ============================================================
const HAND_JOINTS = [
  'index-finger-tip', 'thumb-tip', 'middle-finger-tip',
  'ring-finger-tip', 'pinky-finger-tip', 'palm'
];

const HAND_COLORS = { left: 0x00c8ff, right: 0xff00ff };
const handSpheres = { left: {}, right: {} };

function createHandSpheres(handedness) {
  if (handSpheres[handedness] && Object.keys(handSpheres[handedness]).length > 0) return;
  
  const geom = new THREE.SphereGeometry(0.008, 12, 12);
  const mat = new THREE.MeshBasicMaterial({ 
    color: HAND_COLORS[handedness] || 0x00ffff,
    transparent: true,
    opacity: 0.9
  });
  
  for (const joint of HAND_JOINTS) {
    const sphere = new THREE.Mesh(geom, mat);
    sphere.visible = false;
    sphere.userData.joint = joint;
    sphere.userData.hand = handedness;
    scene.add(sphere);
    handSpheres[handedness][joint] = sphere;
  }
  console.log(`[XR] Hand spheres created for ${handedness}`);
}

// ============================================================
// OBJECT REGISTRY
// ============================================================
let lastObject = null;
const objects = [];

const geometryCache = {
  cube: new THREE.BoxGeometry(0.3, 0.3, 0.3),
  sphere: new THREE.SphereGeometry(0.18, 24, 16),
};

function createObject(kind, colorHex, position, fromVision = false) {
  const geom = geometryCache[kind] || geometryCache.cube;
  
  let safeColor = colorHex;
  if (!safeColor || safeColor === '#000000' || !/^#[0-9a-f]{6}$/i.test(safeColor)) {
    safeColor = '#ffffff';
  }
  
  const mat = new THREE.MeshStandardMaterial({ 
    color: new THREE.Color(safeColor),
    emissive: new THREE.Color(safeColor),
    emissiveIntensity: 0.3,
    roughness: 0.3,
    metalness: 0.6
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.userData.kind = kind;
  mesh.userData.fromVision = fromVision;
  mesh.userData.targetScale = 1;
  mesh.scale.set(0.01, 0.01, 0.01);
  mesh.userData.spawnTime = performance.now();
  
  scene.add(mesh);
  lastObject = mesh;
  objects.push(mesh);
  return mesh;
}

// ============================================================
// ACTION DISPATCHER
// ============================================================
let isVisionResponse = false;

function executeAction(action) {
  console.log('[executeAction]', action, '| vision:', isVisionResponse);
  const { action: verb, object = 'cube', params = {} } = action;
  
  switch (verb) {
    case 'spawn':
      createObject(object, params.color || '#ffffff', params.position || [0, 1.2, -1.5], isVisionResponse);
      break;
    case 'move':
      if (!lastObject) return;
      if (params.delta) lastObject.position.add(new THREE.Vector3(...params.delta));
      else if (params.to) lastObject.position.set(...params.to);
      break;
    case 'scale':
      if (!lastObject) return;
      const factor = params.factor || 1.5;
      lastObject.userData.targetScale = (lastObject.userData.targetScale || 1) * factor;
      break;
    case 'color':
      if (!lastObject) return;
      const newColor = params.color || '#ffffff';
      const safeColor = (newColor === '#000000') ? '#ffffff' : newColor;
      lastObject.material.color.set(safeColor);
      lastObject.material.emissive.set(safeColor);
      break;
    case 'delete': {
      if (objects.length === 0) {
        console.warn('[delete] Scene is empty');
        return;
      }
      
      const targetColor = params?.color;
      let target = null;
      
      if (targetColor) {
        for (let i = objects.length - 1; i >= 0; i--) {
          const obj = objects[i];
          const objColorHex = '#' + obj.material.color.getHexString();
          if (objColorHex.toLowerCase() === targetColor.toLowerCase()) {
            target = obj;
            console.log(`[delete] Targeted color match: ${targetColor}`);
            break;
          }
        }
        if (!target) {
          console.warn(`[delete] No object with color ${targetColor}, deleting last`);
          target = objects[objects.length - 1];
        }
      } else {
        target = objects[objects.length - 1];
      }
      
      scene.remove(target);
      const idx = objects.indexOf(target);
      if (idx > -1) objects.splice(idx, 1);
      lastObject = objects.length > 0 ? objects[objects.length - 1] : null;
      break;
    }
    default:
      console.warn('Unknown action:', verb);
  }
  isVisionResponse = false;
}

// ============================================================
// WEBSOCKET
// ============================================================
const statusEl = document.getElementById('status');
let ws = null;
let msgId = 0;

function connectWS() {
  ws = new WebSocket(WS_URL);
  
  ws.onopen = async () => {
    statusEl.textContent = '🟢 connected';
    
    try {
      const res = await fetch(SCENE_URL);
      const serverScene = await res.json();
      if (serverScene.length > 0) {
        console.log(`[SYNC] Loading ${serverScene.length} objects from server`);
        serverScene.forEach(obj => {
          const exists = objects.some(o => 
            o.userData.kind === obj.kind && 
            o.position.x.toFixed(1) === obj.position[0].toFixed(1) &&
            o.position.y.toFixed(1) === obj.position[1].toFixed(1) &&
            o.position.z.toFixed(1) === obj.position[2].toFixed(1)
          );
          if (!exists) {
            createObject(obj.kind, obj.color, obj.position, false);
          }
        });
      }
    } catch (e) {
      console.warn('[SYNC] Failed:', e.message);
    }
  };
  
  ws.onclose = () => {
    statusEl.textContent = '🔴 disconnected — retrying';
    setTimeout(connectWS, 2000);
  };
  
  ws.onerror = () => { statusEl.textContent = '🔴 ws error'; };
  
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'action') {
        if (msg.vision === true) isVisionResponse = true;
        executeAction(msg.payload);
        
        if (msg.explanation || msg.suggestion) {
          const narrEl = document.getElementById('ai-narration');
          const explEl = document.getElementById('ai-explanation');
          const suggEl = document.getElementById('ai-suggestion');
          
          if (narrEl && explEl && suggEl) {
            explEl.textContent = '🤖 ' + (msg.explanation || '');
            suggEl.textContent = '💡 ' + (msg.suggestion || '');
            narrEl.style.display = 'block';
            
            clearTimeout(window._narrationTimeout);
            window._narrationTimeout = setTimeout(() => {
              narrEl.style.display = 'none';
            }, 8000);
          }
        }
        
        if (msg.stream_step && msg.stream_total) {
          const pct = (msg.stream_step / msg.stream_total) * 100;
          console.log(`[PLAN] Step ${msg.stream_step}/${msg.stream_total} (${pct.toFixed(0)}%)`);
          
          if (statusEl) {
            statusEl.textContent = `🟢 plan ${msg.stream_step}/${msg.stream_total}`;
            if (msg.stream_step === msg.stream_total) {
              setTimeout(() => { statusEl.textContent = '🟢 connected'; }, 500);
            }
          }
        }
      }
    } catch (err) { console.error('bad ws message', err); }
  };
}

connectWS();

function sendCommand(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'command', text, id: `m${++msgId}` }));
}
window.sendCommand = sendCommand;

document.querySelectorAll('#ui button[data-cmd]').forEach((btn) => {
  btn.addEventListener('click', () => sendCommand(btn.dataset.cmd));
});

// ============================================================
// VISION TEST
// ============================================================
const visionBtn = document.getElementById('vision-btn');
if (visionBtn) {
  visionBtn.addEventListener('click', () => {
    renderer.render(scene, camera);
    
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = 512;
    tempCanvas.height = 512;
    const ctx = tempCanvas.getContext('2d');
    ctx.drawImage(renderer.domElement, 0, 0, 512, 512);
    
    const dataURL = tempCanvas.toDataURL('image/jpeg', 0.5);
    const base64Image = dataURL.split(',')[1];
    
    console.log(`[VISION] Compressed image size: ${(base64Image.length / 1024).toFixed(1)} KB`);
    
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.error('[VISION] WebSocket not connected');
      return;
    }
    
    visionBtn.textContent = '👁️ Analyzing...';
    visionBtn.disabled = true;
    visionBtn.style.background = '#ff8800';
    
    ws.send(JSON.stringify({ 
      type: 'command', 
      text: "Look at this image. It is a 3D scene. Based on what you see, spawn a new object next to the existing one.", 
      image: base64Image, 
      id: `vision-${++msgId}` 
    }));
    
    setTimeout(() => {
      visionBtn.textContent = '6. 👁️ Vision Test';
      visionBtn.disabled = false;
      visionBtn.style.background = '#ff00ff';
    }, 15000);
  });
}

// ============================================================
// WEBXR SESSION
// ============================================================
const enterVRBtn = document.getElementById('enter-vr');
let xrSession = null;

enterVRBtn.addEventListener('click', async () => {
  if (!navigator.xr) { alert('WebXR not supported'); return; }
  try {
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['hand-tracking', 'local-floor'],
    });
    xrSession = session;
    renderer.xr.setSession(session);
    enterVRBtn.style.display = 'none';
    
    vrButtonGroup.visible = true;

    createHandSpheres('left');
    createHandSpheres('right');

    session.addEventListener('select', (event) => {
      console.log('[XR] Trigger pulled');
      const frame = event.frame;
      const refSpace = renderer.xr.getReferenceSpace();
      
      if (event.inputSource.targetRaySpace) {
        const rayPose = frame.getPose(event.inputSource.targetRaySpace, refSpace);
        if (rayPose) {
          const origin = new THREE.Vector3().copy(rayPose.transform.position);
          const quat = new THREE.Quaternion().copy(rayPose.transform.orientation);
          const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(quat);
          
          for (const btn of vrButtons) {
            const worldPos = new THREE.Vector3();
            btn.getWorldPosition(worldPos);
            const toBtn = worldPos.clone().sub(origin);
            const projection = toBtn.dot(direction);
            
            if (projection > 0 && projection < 3) {
              const closestPoint = origin.clone().add(direction.clone().multiplyScalar(projection));
              if (closestPoint.distanceTo(worldPos) < 1.5) {
                triggerButton(btn);
                break;
              }
            }
          }
        }
      }
    });

    session.addEventListener('inputsourceschange', (e) => {
      for (const src of e.added) {
        if (src.hand) console.log('[XR] Hand detected:', src.handedness);
        if (src.gamepad) console.log('[XR] Controller detected:', src.handedness);
      }
    });
    session.addEventListener('end', () => {
      xrSession = null;
      enterVRBtn.style.display = 'block';
      vrButtonGroup.visible = false;
      
      for (const hand of ['left', 'right']) {
        for (const joint in handSpheres[hand]) {
          handSpheres[hand][joint].visible = false;
        }
      }
    });
  } catch (err) {
    console.error('VR enter failed', err);
    alert('VR failed: ' + err.message);
  }
});

// ============================================================
// RENDER LOOP
// ============================================================
renderer.setAnimationLoop((time, frame) => {
  if (renderer.xr.isPresenting && frame) {
    const session = renderer.xr.getSession();
    if (session) {
      const refSpace = renderer.xr.getReferenceSpace();
      
          for (const src of session.inputSources) {
        if (!src.hand || !src.handedness) continue;
        
        const spheres = handSpheres[src.handedness];
        if (!spheres) continue;
        
        // --- NEW: PINCH DETECTION LOGIC ---
        const thumbJoint = src.hand.get('thumb-tip');
        const indexJoint = src.hand.get('index-finger-tip');
        let isPinching = false;

        if (thumbJoint && indexJoint) {
            const thumbPose = frame.getJointPose(thumbJoint, refSpace);
            const indexPose = frame.getJointPose(indexJoint, refSpace);
            
            if (thumbPose && indexPose) {
                const thumbPos = new THREE.Vector3().copy(thumbPose.transform.position);
                const indexPos = new THREE.Vector3().copy(indexPose.transform.position);
                
                // If distance is less than 2.5cm, consider it a pinch
                if (thumbPos.distanceTo(indexPos) < 0.025) {
                    isPinching = true;
                }
            }
        }
        // ----------------------------------

        for (const jointName of HAND_JOINTS) {
          const joint = src.hand.get(jointName);
          const sphere = spheres[jointName];
          
          if (!joint || !sphere) continue;
          
          const pose = frame.getJointPose(joint, refSpace);
          if (pose) {
            sphere.position.copy(pose.transform.position);
            sphere.visible = true;

            // --- NEW: VISUAL FEEDBACK FOR PINCH ---
            if (isPinching) {
                // Turn green and grow slightly when pinching
                sphere.material.color.setHex(0x00ff00);
                sphere.scale.set(1.5, 1.5, 1.5);
            } else {
                // Return to normal color
                sphere.material.color.setHex(HAND_COLORS[src.handedness] || 0x00ffff);
                sphere.scale.set(1, 1, 1);
            }
            // --------------------------------------

          } else {
            sphere.visible = false;
          }
        }
      }
    }
  }
  
  checkVRButtonClicks(frame);
  
  objects.forEach(obj => {
    if (obj.userData.targetScale !== undefined) {
      obj.scale.lerp(
        new THREE.Vector3(obj.userData.targetScale, obj.userData.targetScale, obj.userData.targetScale),
        0.15
      );
    }
  });
  
  grid.rotation.y += 0.0005;
  
  renderer.render(scene, camera);
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ============================================================
// VOICE INPUT
// ============================================================
const voiceBtn = document.getElementById('voice-btn');
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

if (SpeechRecognition && voiceBtn) {
  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.maxAlternatives = 1;

  let isListening = false;
  let errorShown = false;
  let lastSentCommand = '';
  let lastSentTime = 0;

  function resetButton() {
    isListening = false;
    errorShown = false;
    voiceBtn.textContent = '🎤 Hold to Speak';
    voiceBtn.style.background = '';
    voiceBtn.disabled = false;
  }

  recognition.onstart = () => {
    voiceBtn.textContent = '🎤 LISTENING…';
    voiceBtn.style.background = '#ff8800';
  };

  recognition.onresult = (event) => {
    const result = event.results[event.results.length - 1];
    const transcript = result[0].transcript.trim();
    
    if (!result.isFinal) {
      voiceBtn.textContent = '🎤 …' + transcript;
      return;
    }
    
    console.log('[VOICE] Final:', transcript);
    
    const now = Date.now();
    if (transcript === lastSentCommand && (now - lastSentTime) < 1500) {
      console.log('[VOICE] Debounced duplicate');
      return;
    }
    lastSentCommand = transcript;
    lastSentTime = now;
    
    voiceBtn.textContent = '🎤 HEARD: "' + transcript + '"';
    voiceBtn.style.background = '#00ff00';
    sendCommand(transcript);
    setTimeout(resetButton, 2000);
  };

  recognition.onerror = (event) => {
    console.error('[VOICE] Error:', event.error);
    errorShown = true;
    voiceBtn.textContent = '🎤 Error: ' + event.error;
    voiceBtn.style.background = '#ff0000';
    setTimeout(resetButton, 2500);
  };

  recognition.onend = () => {
    isListening = false;
    if (!errorShown && voiceBtn.textContent.indexOf('HEARD') === -1) {
      resetButton();
    }
  };

  voiceBtn.addEventListener('mousedown', () => {
    if (isListening) return;
    isListening = true;
    errorShown = false;
    try { recognition.start(); }
    catch (e) { console.error('[VOICE] Start failed:', e); resetButton(); }
  });

  voiceBtn.addEventListener('mouseup', () => {
    if (isListening) { try { recognition.stop(); } catch (e) {} }
  });

  voiceBtn.addEventListener('mouseleave', () => {
    if (isListening) { try { recognition.stop(); } catch (e) {} }
  });

  console.log('[VOICE] Initialized');
} else {
  if (voiceBtn) {
    voiceBtn.textContent = '🎤 Not supported';
    voiceBtn.disabled = true;
    voiceBtn.style.cursor = 'not-allowed';
  }
  console.warn('[VOICE] SpeechRecognition not available');
}

// ============================================================
// UNDO BUTTON
// ============================================================
const undoBtn = document.getElementById('undo-btn');
if (undoBtn) {
  undoBtn.addEventListener('click', () => sendCommand("undo"));
  console.log('[INIT] Undo button wired');
}

// ============================================================
// STATS POLLING (with memory_items)
// ============================================================
async function pollStats() {
    try {
        const res = await fetch(STATS_URL);
        const data = await res.json();
        document.getElementById('stat-count').textContent = data.total_requests;
        
        // Change: add " ms" to the value itself
        document.getElementById('stat-avg').textContent = data.avg_latency_ms + ' ms';
        
        const memEl = document.getElementById('stat-mem');
        if (memEl) memEl.textContent = data.memory_items || 0;
    } catch (e) {}
}
setInterval(pollStats, 2000);
pollStats();

console.log('[INIT] Edge Compute frontend ready — VR buttons hidden in 2D, laser pointers + trigger enabled');