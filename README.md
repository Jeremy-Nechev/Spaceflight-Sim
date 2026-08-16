# Spaceflight Simulator

A browser remake of the 2-D rocket-building game. Bolt parts together in the
hangar, launch, fly a gravity turn, circularise, and go land on the Moon —
then come home under a parachute.

No build step, no dependencies. Plain HTML + CSS + JavaScript on a single
`<canvas>`, so it can be served as static files anywhere.

---

## Play
Open `index.html`, or serve the folder:

```bash
npx serve .
```

### Controls

| Key | Action |
| --- | --- |
| `W` / `S` | Throttle up / down |
| `Z` / `X` | Full throttle / cut |
| `A` / `D` | Rotate left / right |
| `Space` | Fire the next stage group |
| `T` | Cycle stability assist (Off → Hold → Prograde → Retrograde → Up) |
| `M` | Map view |
| `,` / `.` | Time warp down / up |
| `G` | Toggle landing legs |
| `R` | Revert to launch |
| `B` | Back to the hangar |
| `Esc` | Menu |

Mouse wheel or pinch zooms. Touch devices get on-screen throttle, rotate and
stage controls. In the hangar: click a part then click to place it,
drag placed parts to move them, right-click to delete, `Ctrl+Z` to undo.

---

## What's in it

**Building.** Command pods, six fuel tanks, six engines (including a
vacuum-optimised bell, an ion drive and a solid booster), nose cones, fins,
two parachutes, landing legs, RCS blocks, separators, adapters, and couplers —
vertical (in-line truss), linear (sideways beam to hold a parallel stack) and
bi-couplers (one stack splits into two). Parts snap magnetically, and Mirror
mode places fins and boosters symmetrically.

**Thrust power.** A throttle slider with a live percentage, driven by the
keyboard, the slider, or touch. Solid boosters ignore it — they burn flat out
until empty and cannot be shut down.

**Stage groups.** Groups are generated from the layout, then fully editable:
click a part chip and click a row to move it, reorder rows with ▲▼, delete a
row, or add an empty one. The same list appears in flight, where you can click
any group to fire it directly. Parts left out of every group are flagged in
red — they will never fire.

**Fuel compartments.** Separators act as walls in the plumbing, so an engine
only drinks from tanks it is actually connected to. Side boosters burn their
own propellant and your core tank stays full until you need it.

**The world.** A round planet you can fly all the way around, plus an orbiting
Moon with its own sphere of influence. Terrain is a seamless harmonic function,
so the ground is continuous the whole way round and collision uses exactly the
shape you can see.

**Oceans.** Roughly half the surface is water, in a handful of large seas, with
beaches where the land meets them. Splashdowns work: hulls float, and a gentle
arrival is survivable while a fast one is not.

**Ground scenery.** Trees, houses, tower blocks, radio masts and boulders are
generated deterministically along the surface and are solid. Clip a tree while
taxiing and you knock it down; fly into a tower block at speed and you don't
walk away. The launch pad has its own cleared, flattened plateau.

**Clouds.** Flat-bottomed cumulus drifting between 700 m and 9 km, thinning out
as you climb.

**Flight model.** N-body gravity from both worlds, atmospheric drag with real
weathervaning (fins at the back are what keep the nose forward), engine gimbal
and reaction wheels, buoyancy, terrain contact with friction, and numerically
integrated trajectory prediction drawn on the map with apoapsis and periapsis
markers.

**Autopilot.** The bar across the top of the flight screen points the nose for
you so you can concentrate on the throttle: hold the current heading, follow
prograde or retrograde, or aim straight away from the world below. The selected
mode is described in plain English underneath it.

**Hulls collide.** Separated stages are solid objects, not ghosts. A gentle
nudge bounces them apart; leave an engine burning under a stage you have just
dropped and it will chase you down and take both craft out. Exhaust smoke,
dust and debris pile up on the ground — or the sea — instead of sinking
through it.

**Velocity marker.** A green arrow sits out from the centre of the screen
pointing the way you are actually travelling, with your speed printed above it.

### Stock rockets

| Rocket | Notes |
| --- | --- |
| **Kestrel** | Single stage, TWR 1.9, 5.3 km/s of Δv. Reaches orbit comfortably. |
| **Atlas II** | Two solid boosters on side separators plus two liquid stages. |
| **Luna I** | Three stages, 11.2 km/s of Δv and landing legs. Moon capable. |

---

## Scale

Distances are scaled down so a flight takes minutes rather than hours, while
keeping the shape of real orbital mechanics.

| | Radius | Surface gravity | Orbital speed |
| --- | --- | --- | --- |
| Earth | 300 km | 9.8 m/s² | ≈ 1 715 m/s |
| Moon | 100 km | 1.6 m/s² | ≈ 400 m/s |

Atmosphere ends at 60 km. The Moon orbits at 4 000 km with a 14.9-hour period
and an 804 km sphere of influence. Low orbit costs about 2 300 m/s; a full
Moon landing and return is roughly 4 800 m/s.

Attitude control is deliberately gamey: reaction wheels produce a torque
proportional to the craft's moment of inertia, so a big rocket turns at a
similar rate to a small one — roughly 45° in under 3 s, even against max
dynamic pressure during the gravity turn. The aerodynamic *forces* are
unscaled, so ascent losses stay honest; only the weathervaning moment is
softened, which is what keeps the craft steerable while fins still point the
nose forward on their own. Everything else — thrust, Isp, mass flow, drag,
gravity — is the real equations.

---

## Deploying to GitHub Pages

The repository is already set up: `.github/workflows/pages.yml` publishes the
root of `main` on every push, and `.nojekyll` stops Jekyll from touching it.

```bash
git init -b main
git add -A
git commit -m "Spaceflight Simulator"
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

Then in the repository, **Settings → Pages → Build and deployment → Source:
GitHub Actions**. The next push publishes to
`https://<you>.github.io/<repo>/`.

Every asset is referenced with a relative path, so serving from a
`/<repo>/` subpath works with no configuration.

---

## Layout

```
index.html          markup for every screen
styles.css          UI chrome
js/util.js          maths, formatting, storage
js/audio.js         WebAudio engine rumble and one-shots
js/parts.js         part catalogue and part artwork
js/world.js         planets, terrain, oceans, scenery, clouds, orbital maths
js/vessel.js        rigid body, fuel compartments, stage groups, separation
js/physics.js       one simulation step: gravity, aero, water, contact
js/render.js        camera, planets, vessels, exhaust, particles, map view
js/builder.js       the assembly hangar
js/flight.js        flight scene, time warp, HUD, mission log
js/main.js          canvas, game loop, scene switching, UI wiring
```

Scripts are classic (non-module) tags loaded in order onto a single `SFS`
namespace, which is why opening `index.html` straight off disk works.
