const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const { loadModule } = require('./helpers/module.cjs');

const source = readFileSync(join(__dirname, '../js/vr.js'), 'utf8');
const { VRSystem } = loadModule(source, {
  imports: { 'three/webgpu': {}, 'three/tsl': {}, './city-config.js': { getLocationLabel: () => '' } },
  globals: { Math, Number, Object, Boolean, URLSearchParams, performance },
  filename: 'vr.js'
});

// An 'xr-standard' controller: 0 trigger, 1 grip, 4 A / X, 5 B / Y; axes 2 & 3 the stick
function pad({ x = 0, y = 0, trigger = 0, grip = 0, a = false, b = false } = {}) {
  const button = (value) => ({ value, pressed: value > 0.5 });
  return { gamepad: { axes: [0, 0, x, y], buttons: [button(trigger), button(grip), button(0), button(0), button(a ? 1 : 0), button(b ? 1 : 0)] } };
}

function rig(mode, view = 'first') {
  const inputs = {};
  const calls = [];
  const vr = Object.create(VRSystem.prototype);
  Object.assign(vr, {
    view,
    turn: 0,
    turnHeld: false,
    sources: { left: pad(), right: pad() },
    previous: { left: [], right: [] },
    headForward: { x: 0, y: 0, z: -1 },
    callbacks: {
      onCycleMode: (step) => calls.push(['mode', step]),
      onCycleTime: () => calls.push(['time']),
      onHorn: () => calls.push(['horn'])
    },
    applyView: () => calls.push(['view']),
    controller: {
      activeMode: mode,
      entities: { person: { heading: 0 } },
      setGamepadInput: (action, value) => { inputs[action] = value; }
    }
  });
  return { vr, inputs, calls };
}

test('driving: right trigger is the gas, left trigger the brake, left stick steers, A honks', () => {
  const { vr, inputs, calls } = rig('car');
  vr.sources.right = pad({ trigger: 1, a: true });
  vr.sources.left = pad({ x: -1, trigger: 0.25 });
  vr.updateInput();
  assert.equal(inputs.forward, 1);
  assert.equal(inputs.backward, 0.25);
  assert.equal(inputs.left, 1);
  assert.equal(inputs.right, 0);
  assert.deepEqual(calls, [['horn']]);
});

test('flying: the left stick pitches and yaws, the triggers climb and descend', () => {
  const { vr, inputs } = rig('helicopter');
  vr.sources.left = pad({ y: -1, x: 1, trigger: 1 });
  vr.sources.right = pad({ trigger: 0.5 });
  vr.updateInput();
  assert.equal(inputs.forward, 1);
  assert.equal(inputs.right, 1);
  assert.equal(inputs.up, 0.5);
  assert.equal(inputs.down, 1);
});

test('walking in first person goes where the head looks, and the grip runs', () => {
  const { vr, inputs } = rig('person');
  const { controller } = vr;
  vr.headForward = { x: 1, y: 0, z: 0 }; // looking east (+x)
  vr.sources.left = pad({ y: -1 });
  vr.updateInput();
  assert.ok(Math.abs(controller.entities.person.heading - Math.PI / 2) < 1e-9, 'heading east');
  assert.ok(inputs.forward > 0.3 && inputs.forward < 0.5, 'walks without the grip');
  vr.sources.left = pad({ x: 1, grip: 1 }); // stick right: turn to the head's right (south, +z)
  vr.updateInput();
  assert.ok(Math.abs(controller.entities.person.heading) < 1e-9, 'heading south');
  assert.equal(inputs.forward, 1);
});

test('buttons act once per press, and the snap turn once per push', () => {
  const { vr, calls } = rig('car');
  vr.sources.right = pad({ b: true, x: 1 });
  vr.sources.left = pad({ a: true, b: true }); // X and Y
  vr.updateInput();
  vr.updateInput();
  assert.deepEqual(calls, [['mode', 1], ['view'], ['time']]);
  assert.equal(vr.view, 'third');
  assert.ok(Math.abs(vr.turn + Math.PI / 6) < 1e-9, 'stick right turns right');
  vr.sources.right = pad();
  vr.updateInput();
  vr.sources.right = pad({ x: -1 });
  vr.updateInput();
  assert.ok(Math.abs(vr.turn) < 1e-9);
});
