import * as THREE from 'three/webgpu';
import { context, renderOutput } from 'three/tsl';
import { getLocationLabel } from './city-config.js';

// WebXR (VR) for headsets such as the Meta Quest: a seat in the active vehicle (or the eyes of the walker), a chase view
// behind it, input from the two controllers, and a small panel on the left wrist.
//
// The headset only turns the view about the vertical axis: the helicopter's pitch and roll and the bike's lean stay out
// of the view, which keeps the horizon level and the ride comfortable.
//
// The city draws into a buffer of the renderer's own (the frame buffer target, the same path as the flat page), and one
// pass copies it into the headset's texture with the tone mapping. On the Quest, drawing the city straight into the
// headset's texture (multisampled render-to-texture with the headset's depth) shows old memory where the sky should be.
//
// The flat shaders draw into the post-processing chain; VR needs shaders of its own (two eyes, no reflection outputs). The first session of a visit compiles them in the background, while a panel in the headset shows the
// progress, and any error.
//
// URL options: ?vrscale=0.7 (resolution, share of the headset's own), ?multiview (draw both eyes at once),
// ?vrnoshadows (no sun shadows: faster), ?vrdirect (draw straight into the headset's texture, see above).

const BODY_LAYER = 4; // the player's own body and helmet: out of the first-person view, so you don't look out of your own head
const SNAP_TURN = Math.PI / 6;
const DEAD_ZONE = 0.15;
const WALK = 0.4; // share of the top running speed (8.2 m/s) when walking; hold a grip to run
const PERSON_EYE = 1.68;
const PARAMS = new URLSearchParams(globalThis.location?.search || '');
const SCALE = Math.min(1, Math.max(0.3, Number(PARAMS.get('vrscale')) || 0.7));
const SHADOWS = !PARAMS.has('vrnoshadows');
const DIRECT = PARAMS.has('vrdirect');
const MODE_LABELS = { person: 'Walk', car: 'Drive', cyclist: 'Cycle', helicopter: 'Fly' };
const HELP = {
  person: ['Left stick  walk (look to steer)', 'Grip  run · A  jump'],
  car: ['Right trigger  gas · Left trigger  brake', 'Left stick  steer · A  horn'],
  cyclist: ['Right trigger  pedal · Left trigger  brake', 'Left stick  lean & turn'],
  helicopter: ['Left stick  pitch & yaw', 'Right trigger  up · Left trigger  down']
};

function deadZone(v) {
  v = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
  return Math.sign(v) * Math.max(0, (Math.abs(v) - DEAD_ZONE) / (1 - DEAD_ZONE));
}

// The 'xr-standard' gamepad of one controller: 0 trigger, 1 grip, 3 stick press, 4 A / X, 5 B / Y; axes 2 & 3 the stick
function readPad(source) {
  const pad = source?.gamepad;
  const value = (i) => {
    const b = pad?.buttons?.[i];
    return Number.isFinite(b?.value) ? b.value : b?.pressed ? 1 : 0;
  };
  return {
    x: deadZone(pad?.axes?.[2]),
    y: deadZone(pad?.axes?.[3]),
    trigger: value(0),
    grip: value(1),
    pressed: [0, 1, 2, 3, 4, 5].map((i) => Boolean(pad?.buttons?.[i]?.pressed))
  };
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isVRSupported() {
  try {
    return Boolean(navigator.xr) && await navigator.xr.isSessionSupported('immersive-vr');
  } catch {
    return false;
  }
}

class VRSystem {
  constructor({ renderer, scene, controllerManager, cameraSystem, sunLight, button, callbacks = {} }) {
    this.renderer = renderer;
    this.sunLight = sunLight;
    this.controller = controllerManager;
    this.cameraSystem = cameraSystem;
    this.callbacks = callbacks;
    this.button = button;
    this.session = null;
    this.presenting = false;
    this.view = 'first'; // 'first' (seat / eyes) or 'third' (chase)
    this.turn = 0; // snap turns, added to the rig's heading
    this.turnHeld = false;
    this.viewKey = '';
    this.flatPreset = 'chase';
    this.sources = { left: null, right: null };
    this.previous = { left: [], right: [] };
    this.headForward = new THREE.Vector3(0, 0, -1);
    this.panelTimer = 0;
    this.phase = 'idle'; // 'preparing' (compiling the VR shaders), then 'ready'; 'failed' after an error
    this.prepared = false; // the VR shaders compile once per visit
    this.progress = [0, 0];
    this.errors = [];
    this.prepDirty = true;
    this.flatOutput = null;
    this.vrContext = null;
    this.fps = 0;
    this.lastFrame = 0;
    this.frameStart = 0;
    this.jsMs = 0;

    renderer.xr.enabled = true;
    renderer.xr.setReferenceSpaceType('local'); // origin at the head when the session starts: the rig is the eye point
    renderer.xr.setFramebufferScaleFactor(SCALE);

    // The rig carries the headset and the controllers through the city; scene.matrixWorldAutoUpdate is off, so
    // updateView() refreshes its matrices by hand
    this.rig = new THREE.Group();
    this.rig.name = 'VRRig';
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.3, 12000);
    this.rig.add(this.camera);
    scene.add(this.rig);

    // The player's body on a layer of its own: the flat cameras and the sun's shadow keep seeing it, the first-person
    // VR view doesn't
    const ents = controllerManager.entities;
    const body = [...ents.person.crowd.meshes, ...ents.cyclist.riderCrowd.meshes, ents.cyclist.helmet];
    for (const root of body) root.traverse((o) => o.layers.set(BODY_LAYER));
    cameraSystem.camera.layers.enable(BODY_LAYER);
    sunLight.shadow.camera.layers.enable(BODY_LAYER);

    this.buildControllers();
    this.buildPanel();
    this.buildPrep();
    this.catchErrors();

    if (button) {
      button.hidden = false;
      button.addEventListener('click', () => this.toggle());
    }
  }

  buildControllers() {
    const bodyGeo = new THREE.BoxGeometry(0.035, 0.03, 0.11);
    bodyGeo.translate(0, -0.01, 0.02);
    const ringGeo = new THREE.TorusGeometry(0.035, 0.006, 6, 20);
    ringGeo.translate(0, 0.012, -0.045);
    const bodyMat = new THREE.MeshStandardNodeMaterial({ color: 0x23262d, roughness: 0.5 });
    const ringMat = new THREE.MeshStandardNodeMaterial({ color: 0xf6c21c, roughness: 0.4 });
    this.grips = [0, 1].map((i) => {
      const grip = this.renderer.xr.getControllerGrip(i);
      grip.add(new THREE.Mesh(bodyGeo, bodyMat));
      grip.add(new THREE.Mesh(ringGeo, ringMat));
      grip.addEventListener('connected', (e) => {
        const hand = e.data?.handedness;
        if (hand !== 'left' && hand !== 'right') return;
        this.sources[hand] = e.data;
        this.previous[hand] = readPad(e.data).pressed; // a held button is not a fresh press
        if (hand === 'left') grip.add(this.panel);
      });
      grip.addEventListener('disconnected', (e) => {
        const hand = e.data?.handedness;
        if (this.sources[hand] === e.data) this.sources[hand] = null;
        if (this.panel.parent === grip) grip.remove(this.panel);
      });
      this.rig.add(grip);
      return grip;
    });
  }

  // Mode, speed, street corner and the buttons, on the left wrist
  buildPanel() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512;
    this.canvas.height = 320;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicNodeMaterial({ map: this.texture, toneMapped: false, fog: false });
    this.panel = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.1), material);
    this.panel.name = 'VRPanel';
    this.panel.position.set(0, 0.045, 0.02);
    this.panel.rotation.x = -Math.PI / 3; // faces up and back, toward the eyes when you look at your wrist
    this.panel.frustumCulled = false;
    this.drawPanel();
  }

  drawPanel() {
    const c = this.ctx, w = this.canvas.width, h = this.canvas.height;
    const cm = this.controller, ent = cm.getActiveEntity(), mode = cm.activeMode;
    c.fillStyle = '#14161b';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#f6c21c';
    c.fillRect(0, 0, w, 8);
    c.fillStyle = '#ffffff';
    c.font = '700 44px Inter, system-ui, sans-serif';
    c.fillText(MODE_LABELS[mode] || mode, 24, 62);
    c.textAlign = 'right';
    c.fillText(`${Math.round(Math.abs(ent.speed) * 2.237)} mph`, w - 24, 62);
    c.textAlign = 'left';
    c.fillStyle = '#c9ced8';
    c.font = '500 26px Inter, system-ui, sans-serif';
    const where = getLocationLabel(ent.position.x, ent.position.z);
    c.fillText(where.length > 34 ? `${where.slice(0, 33)}…` : where, 24, 104);
    if (mode === 'helicopter') c.fillText(`${Math.max(0, Math.round(ent.position.y * 3.281)).toLocaleString('en-US')} ft`, 24, 138);
    c.fillStyle = '#8f96a3';
    c.font = '500 22px Inter, system-ui, sans-serif';
    const lines = [...(HELP[mode] || []), 'Right stick  turn · B  next mode', `X  time of day · Y  ${this.view === 'first' ? 'chase view' : 'first person'}`];
    lines.forEach((line, i) => c.fillText(line, 24, 186 + i * 32));
    c.textAlign = 'right';
    c.fillStyle = this.fps < 45 ? '#ff8a7a' : '#8f96a3';
    c.fillText(`${Math.round(this.fps)} fps · js ${Math.round(this.jsMs)} ms`, w - 24, 138);
    c.textAlign = 'left';
    this.texture.needsUpdate = true;
  }

  // A panel two metres ahead while the VR shaders compile (or after an error), in a scene of its own
  buildPrep() {
    this.prepCanvas = document.createElement('canvas');
    this.prepCanvas.width = 1024;
    this.prepCanvas.height = 640;
    this.prepTexture = new THREE.CanvasTexture(this.prepCanvas);
    this.prepTexture.colorSpace = THREE.SRGBColorSpace;
    this.prepScene = new THREE.Scene();
    this.prepScene.background = new THREE.Color(0x07080b);
    this.prepGroup = new THREE.Group();
    this.prepGroup.matrixAutoUpdate = false;
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(1.6, 1),
      new THREE.MeshBasicNodeMaterial({ map: this.prepTexture, toneMapped: false, fog: false })
    );
    panel.position.set(0, -0.1, -2.2);
    this.prepGroup.add(panel);
    this.prepScene.add(this.prepGroup);
  }

  drawPrep() {
    const c = this.prepCanvas.getContext('2d'), w = this.prepCanvas.width, h = this.prepCanvas.height;
    const [done, total] = this.progress;
    c.fillStyle = '#14161b';
    c.fillRect(0, 0, w, h);
    c.fillStyle = '#f6c21c';
    c.fillRect(0, 0, w, 10);
    c.fillStyle = '#ffffff';
    c.font = '700 56px Inter, system-ui, sans-serif';
    c.fillText('Slop New York VR', 48, 104);
    c.font = '500 34px Inter, system-ui, sans-serif';
    c.fillStyle = '#c9ced8';
    const status = this.phase === 'failed' ? 'Something went wrong'
      : total > 0 ? `Compiling shaders for VR  ${done} / ${total}` : 'Getting ready...';
    c.fillText(status, 48, 176);
    if (this.phase !== 'failed') {
      c.fillStyle = '#2a2e37';
      c.fillRect(48, 206, w - 96, 18);
      c.fillStyle = '#f6c21c';
      c.fillRect(48, 206, (w - 96) * (total > 0 ? done / total : 0), 18);
      c.fillStyle = '#8f96a3';
      c.font = '500 28px Inter, system-ui, sans-serif';
      c.fillText('This happens once per visit.', 48, 274);
    }
    c.fillStyle = '#ff8a7a';
    c.font = '500 24px ui-monospace, Menlo, monospace';
    let y = 330;
    for (const line of this.errors.slice(-4)) {
      for (let i = 0; i < line.length && y < h - 70; i += 70, y += 32) c.fillText(line.slice(i, i + 70), 48, y);
      y += 12;
    }
    c.fillStyle = '#8f96a3';
    c.font = '500 26px Inter, system-ui, sans-serif';
    c.fillText('Press the Meta button to leave VR.', 48, h - 36);
    this.prepTexture.needsUpdate = true;
    this.prepDirty = false;
  }

  // Errors while in VR go on the prep panel, and on the page after the session
  catchErrors() {
    const report = (message) => {
      if (this.presenting) this.report(message);
    };
    window.addEventListener('error', (e) => report(e.message));
    window.addEventListener('unhandledrejection', (e) => report(String(e.reason?.message || e.reason)));
    this.renderer.domElement?.addEventListener('webglcontextlost', () => report('The WebGL context was lost (out of GPU memory?)'));
    const consoleError = console.error.bind(console);
    console.error = (...args) => {
      consoleError(...args);
      report(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    };
  }

  report(message) {
    message = String(message).replace(/\s+/g, ' ').trim().slice(0, 420);
    if (!message || this.errors.at(-1) === message) return;
    this.errors.push(message);
    if (this.errors.length > 8) this.errors.shift();
    this.prepDirty = true;
  }

  showErrorsOnPage() {
    if (this.errors.length === 0) return;
    const note = document.createElement('div');
    note.className = 'vr-note';
    note.textContent = `VR: ${this.errors.slice(-3).join(' | ')} (click to close)`;
    note.addEventListener('click', () => note.remove());
    document.body.appendChild(note);
  }

  // VR settings: with ?vrnoshadows, no sun shadows; with ?vrdirect, no frame buffer target (each material applies the
  // tone mapping and the sRGB encoding itself)
  useVROutput() {
    const r = this.renderer;
    this.flatOutput = { toneMapping: r.toneMapping, outputColorSpace: r.outputColorSpace, contextNode: r.contextNode, castShadow: this.sunLight.castShadow };
    if (!SHADOWS) this.sunLight.castShadow = false;
    if (!DIRECT) return;
    if (!this.vrContext) {
      const { toneMapping, outputColorSpace, contextNode } = this.flatOutput;
      this.vrContext = context({
        getOutput: (outputNode, builder) => {
          const output = renderOutput(outputNode, builder.material?.toneMapped === false ? THREE.NoToneMapping : toneMapping, outputColorSpace);
          output.premultipliedAlpha = builder.material?.premultipliedAlpha;
          return output;
        },
        ...contextNode.getFlowContextData()
      });
    }
    r.toneMapping = THREE.NoToneMapping;
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.contextNode = this.vrContext;
  }

  useFlatOutput() {
    if (!this.flatOutput) return;
    const r = this.renderer;
    r.toneMapping = this.flatOutput.toneMapping;
    r.outputColorSpace = this.flatOutput.outputColorSpace;
    r.contextNode = this.flatOutput.contextNode;
    this.sunLight.castShadow = this.flatOutput.castShadow;
    this.flatOutput = null;
  }

  async prepare() {
    this.phase = 'preparing';
    this.progress = [0, 0];
    this.prepDirty = true;
    // The XR camera has its two eyes once the first frames came in
    const xr = this.renderer.xr;
    for (let i = 0; i < 100 && this.presenting && xr.getCamera().cameras.length < 2; i++) await wait(50);
    await wait(200); // a few frames of the panel first
    if (!this.presenting) return;
    try {
      await this.callbacks.onPrepare?.(this.camera, (done, total) => {
        this.progress = [done, total];
        this.prepDirty = true;
      }, () => !this.presenting);
      if (!this.presenting) return;
      this.prepared = true;
      this.phase = 'ready';
    } catch (e) {
      this.report(`Compile: ${e?.message || e}`);
      this.phase = 'failed';
    }
  }

  // Each VR frame: the city once the shaders are ready, else the prep panel
  render(scene) {
    const r = this.renderer;
    const now = performance.now();
    if (this.lastFrame > 0) {
      const dt = Math.max(1e-3, (now - this.lastFrame) / 1000);
      this.fps = this.fps > 0 ? this.fps + (1 / dt - this.fps) * 0.05 : 1 / dt;
    }
    this.lastFrame = now;
    if (this.phase === 'ready') {
      try {
        r.render(scene, this.camera);
        if (this.frameStart > 0) this.jsMs += (performance.now() - this.frameStart - this.jsMs) * 0.05;
        return;
      } catch (e) {
        this.report(`Render: ${e?.message || e}`);
        this.phase = 'failed';
      }
    }
    if (this.prepDirty) this.drawPrep();
    this.prepGroup.matrix.copy(this.rig.matrixWorld);
    this.prepGroup.matrixWorldNeedsUpdate = true;
    this.prepScene.updateMatrixWorld(true);
    try {
      r.render(this.prepScene, this.camera);
    } catch (e) {
      console.warn('[vr] panel', e);
    }
  }

  async toggle() {
    if (this.session) {
      await this.session.end();
      return;
    }
    try {
      const session = await navigator.xr.requestSession('immersive-vr', { optionalFeatures: ['layers'] });
      await this.renderer.xr.setSession(session);
      this.start(session);
    } catch (e) {
      console.warn('[vr]', e);
      this.errors = [`Could not start VR: ${e?.message || e}`];
      this.showErrorsOnPage();
    }
  }

  start(session) {
    this.session = session;
    this.presenting = true;
    this.errors = [];
    this.renderer.xr.setFoveation(1);
    this.useVROutput();
    session.addEventListener('end', () => this.end(), { once: true });
    this.flatPreset = this.cameraSystem.activePresetId;
    this.viewKey = '';
    this.controller.clearGamepadInput();
    this.callbacks.onEnter?.();
    this.applyView();
    if (this.prepared) this.phase = 'ready';
    else this.prepare();
    if (this.button) {
      this.button.setAttribute('aria-pressed', 'true');
      this.button.title = 'Exit VR';
    }
  }

  end() {
    this.session = null;
    this.presenting = false;
    this.phase = 'idle';
    this.lastFrame = 0;
    this.fps = 0;
    this.useFlatOutput();
    this.controller.clearGamepadInput();
    this.cameraSystem.onResize(window.innerWidth, window.innerHeight);
    this.callbacks.onSelectCamera?.(this.flatPreset);
    this.callbacks.onExit?.();
    this.showErrorsOnPage();
    if (this.button) {
      this.button.setAttribute('aria-pressed', 'false');
      this.button.title = 'Enter VR';
    }
  }

  // The flat camera preset under the VR view: the cockpit / eye point in first person, the chase camera in third
  applyView() {
    this.cameraSystem.resetOrbit();
    this.callbacks.onSelectCamera?.(this.view === 'first' ? 'pov' : 'chase');
    // Culling, street lights, traffic and audio read the flat camera: in VR it follows the head (see updateView()),
    // with a field of view as wide as the headset's
    const cam = this.cameraSystem.camera;
    cam.fov = 110;
    cam.aspect = 1.2;
    cam.updateProjectionMatrix();
    this.panelTimer = 0;
  }

  // Before the controllers update: the two XR controllers drive the same inputs as a gamepad
  updateInput() {
    this.frameStart = performance.now(); // the start of the frame's work, for the js time on the wrist panel
    const cm = this.controller;
    const L = readPad(this.sources.left), R = readPad(this.sources.right);
    const edge = (hand, pad, i) => pad.pressed[i] && !this.previous[hand][i];
    const nextMode = edge('right', R, 5), toggleView = edge('left', L, 5), nextTime = edge('left', L, 4), pressA = edge('right', R, 4);
    this.previous.left = L.pressed;
    this.previous.right = R.pressed;

    if (nextMode) this.callbacks.onCycleMode?.(1);
    if (toggleView) {
      this.view = this.view === 'first' ? 'third' : 'first';
      this.applyView();
    }
    if (nextTime) this.callbacks.onCycleTime?.();

    if (Math.abs(R.x) > 0.7 && !this.turnHeld) {
      this.turn -= Math.sign(R.x) * SNAP_TURN; // stick right turns right (clockwise seen from above)
      this.turnHeld = true;
    } else if (Math.abs(R.x) < 0.3) {
      this.turnHeld = false;
    }

    const mode = cm.activeMode;
    const input = { forward: 0, backward: 0, left: 0, right: 0, up: 0, down: 0 };
    if (mode === 'person') {
      const run = L.grip > 0.5 || R.grip > 0.5 ? 1 : WALK;
      if (this.view === 'first') {
        // Walk where you look: the stick picks the direction relative to the head, the walker turns to it
        const amount = Math.min(1, Math.hypot(L.x, L.y));
        if (amount > 0) {
          const f = this.headForward;
          const dx = f.x * -L.y - f.z * L.x;
          const dz = f.z * -L.y + f.x * L.x;
          cm.entities.person.heading = Math.atan2(dx, dz);
          input.forward = amount * run;
        }
      } else {
        input.forward = Math.max(0, -L.y) * run;
        input.backward = Math.max(0, L.y) * run;
        input.left = Math.max(0, -L.x);
        input.right = Math.max(0, L.x);
      }
      input.up = R.pressed[4] ? 1 : 0;
    } else if (mode === 'car' || mode === 'cyclist') {
      input.forward = R.trigger;
      input.backward = L.trigger;
      input.left = Math.max(0, -L.x);
      input.right = Math.max(0, L.x);
      if (pressA && mode === 'car') this.callbacks.onHorn?.();
    } else {
      input.forward = Math.max(0, -L.y);
      input.backward = Math.max(0, L.y);
      input.left = Math.max(0, -L.x);
      input.right = Math.max(0, L.x);
      input.up = R.trigger;
      input.down = L.trigger;
    }
    for (const [action, value] of Object.entries(input)) cm.setGamepadInput(action, value);
  }

  // After the flat camera updates: put the rig at the eye point and give the head pose to the flat camera
  updateView(dt) {
    const cm = this.controller, cs = this.cameraSystem, ent = cm.getActiveEntity();
    const firstPerson = this.view === 'first';
    const walker = firstPerson && ent.type === 'person';

    // A new mode or view starts facing forward
    const key = `${cm.activeMode}/${this.view}`;
    if (key !== this.viewKey) {
      this.viewKey = key;
      this.turn = walker ? ent.heading + Math.PI : 0;
      if (cs.activePresetId !== (firstPerson ? 'pov' : 'chase')) this.applyView();
    }

    let yaw = 0;
    if (walker) {
      this.rig.position.set(ent.position.x, ent.position.y + PERSON_EYE, ent.position.z);
    } else if (firstPerson) {
      this.rig.position.copy(cs.currentPos);
      yaw = ent.heading + Math.PI;
    } else {
      this.rig.position.copy(cs.currentPos);
      yaw = Math.atan2(cs.currentPos.x - cs.currentLookAt.x, cs.currentPos.z - cs.currentLookAt.z);
    }
    this.rig.rotation.set(0, yaw + this.turn, 0);
    this.camera.layers.set(0);
    if (!firstPerson) this.camera.layers.enable(BODY_LAYER);
    this.rig.updateMatrixWorld(true);

    const xr = this.renderer.xr;
    xr.updateCamera(this.camera);
    const head = xr.getCamera();
    const cam = cs.camera;
    head.matrixWorld.decompose(cam.position, cam.quaternion, cam.scale);
    cam.scale.set(1, 1, 1);
    cam.updateMatrixWorld(true);
    this.headForward.set(0, 0, -1).applyQuaternion(cam.quaternion).setY(0);
    if (this.headForward.lengthSq() < 1e-6) this.headForward.set(-Math.sin(this.rig.rotation.y), 0, -Math.cos(this.rig.rotation.y));
    this.headForward.normalize();

    this.panelTimer -= dt;
    if (this.phase === 'ready' && this.panelTimer <= 0 && this.panel.parent) {
      this.drawPanel();
      this.panelTimer = 0.25;
    }
  }
}

export { VRSystem, isVRSupported };
