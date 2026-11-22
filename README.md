# Slop New York

A New York City simulation built with [three.js](https://threejs.org/), WebGPURenderer, and TSL. Explore Manhattan on foot, by car, by bicycle, or by helicopter.

[Try it live](https://mrdoob.github.io/slop-newyork/)

## VR

Open the page in the Meta Quest Browser (or a desktop browser with a headset) and click **VR** in the toolbar. You sit
in the active vehicle, or see through the walker's eyes; the view only turns about the vertical axis, so the horizon
stays level.

| Control | Walk | Drive / Cycle | Fly |
|---|---|---|---|
| Left stick | walk where you look | steer | pitch & yaw |
| Right trigger | | gas / pedal | up |
| Left trigger | | brake / reverse | down |
| Grip | run | | |
| A | jump | horn | |

Right stick: snap turn · B: next mode · X: time of day · Y: first person / chase view. A panel on the left wrist
shows the mode, speed and street corner.

In VR the city draws straight to the headset with the WebGL 2 backend (WebXR has no WebGPU binding yet), so the
screen-space effects (reflections, ambient occlusion, bloom and the colour grade) are off.

The first VR session of a visit compiles the VR shaders (two eyes, output straight to the headset) while a panel in
the headset shows the progress. The sun's shadows are off in VR. The wrist panel shows the frame rate, and the time
of the updates (sim) and of the draw calls (draw) in milliseconds; if both are well under the frame time, the GPU is
the limit. URL options: `?vrscale=0.6` sets the resolution (share of the headset's own, default 0.6), `?multiview`
draws both eyes in one pass, `?vrshadows` keeps the sun's shadows, `?vrcopy` draws into the renderer's own buffer
and copies it to the headset. Options combine: `?multiview&vrscale=0.5`.

## Make it your own

Fork it, remix it, improve it, break it. Make games, animations, films, experiments, or something completely different. Use it as a starting point and take it wherever you want. Have fun!

Bringing it to your own city? [PORTING.md](PORTING.md) maps out what's reusable, what reads replaceable data, and what's New York through and through.

Explore other cities and community remixes in [Slop Cities](https://github.com/zz85/slop-cities).

## License and data

The project code is available under the [MIT License](LICENSE).

Geographic data: NYC Open Data (including [building footprints and heights](https://data.cityofnewyork.us/City-Government/BUILDING/5zhs-2jue) and [tree locations](https://data.cityofnewyork.us/Environment/Forestry-Tree-Points/hn5i-inap)), [MTA subway entrances](https://data.ny.gov/Transportation/MTA-Subway-Entrances-and-Exits-2024/i9wp-a4ja), and © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL). Third-party data and dependencies retain their respective licenses.
