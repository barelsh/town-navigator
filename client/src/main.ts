import * as THREE from 'three';
import './styles.css';
import { fetchTileIndex, fetchTown } from './api/townApi.ts';
import { createFollowCamera } from './camera/followCamera.ts';
import { createCarController } from './car/carController.ts';
import { createCarModel } from './car/carModel.ts';
import { createRoadLock } from './car/roadLock.ts';
import { chaseOffset } from './car/vehicles.ts';
import { APPEARANCE_SHORTCUT, DEFAULT_TOWN, MONITORING_SHORTCUT, ROAD_LOCK_SHORTCUT, TOWN_LOAD_MODE } from './config.ts';
import { createBuildingTooltip } from './hud/buildingTooltip.ts';
import { createCompass } from './hud/compass.ts';
import { createFavoritesDialog } from './hud/favoritesDialog.ts';
import { createJunctionDebug } from './hud/junctionDebug.ts';
import { createSpeedDisplay } from './hud/speed.ts';
import { createPerfMonitor } from './hud/perfMonitor.ts';
import { createSettingsDialog, isTyping } from './hud/settingsDialog.ts';
import { createTileMap } from './hud/tileMap.ts';
import { createLocationReadout } from './hud/location.ts';
import { createStreetReadout } from './hud/streetReadout.ts';
import { addGround, createStage } from './scene/stage.ts';
import { buildingInfo } from './town/buildingInfo.ts';
import { createBuildingPicker } from './town/buildingPicker.ts';
import { currentStreet, hitsVehicle, outsideDepth, vehicleOverlap } from './town/collision.ts';
import { favoritesOf, fromWorld, loadSettings, saveFavorites, saveSettings, speedLimitOf, appearanceOf, monitoringEnabled, roadLockOf, toWorld, townSettings, vehicleOf } from './settings/settingsStore.ts';
import { findStart } from './town/roads.ts';
import { createTileManager, createWholeTown, type TownTiles } from './town/tileManager.ts';
import { createTownKit } from './town/townChunk.ts';

const MAX_FRAME_TIME = 0.05; // seconds

async function main(): Promise<void> {
  const status = document.getElementById('status')!;

  try {
    const stage = createStage();
    const { renderer, scene, camera } = stage;

    const settings = loadSettings();
    const perf = createPerfMonitor(renderer);
    const junctionDebug = createJunctionDebug(scene); // the road graph overlay shows with the panel
    const setMonitoring = (visible: boolean) => {
      perf.setVisible(visible);
      junctionDebug.setVisible(visible);
    };
    setMonitoring(monitoringEnabled(settings));
    let appearance = appearanceOf(settings);
    const kit = createTownKit(renderer);
    const streaming = TOWN_LOAD_MODE === 'tiles';
    status.textContent = streaming ? 'Loading tiles…' : 'Loading town…';
    const tiles: TownTiles = streaming
      ? createTileManager(DEFAULT_TOWN, scene, kit, appearance, await fetchTileIndex(DEFAULT_TOWN))
      : createWholeTown(scene, kit, await fetchTown(DEFAULT_TOWN), appearance);
    addGround(scene, renderer, tiles.index.bbox);

    const carModel = createCarModel(vehicleOf(settings));
    scene.add(carModel.group);
    const target = toWorld(townSettings(settings, DEFAULT_TOWN).startPoint);
    await tiles.ensureLoaded(target); // the 3 x 3 around the start point, before the first frame
    const roadLock = createRoadLock();
    const car = createCarController(carModel, findStart(tiles.segmentsNear(target), target), (x, z, heading) =>
      Math.max(vehicleOverlap(tiles.obstaclesNear(), x, z, heading, carModel.collision), outsideDepth(tiles.index.bbox, x, z)), {
      get active() { return roadLock.active; },
      step: (pose, speed, dt) => roadLock.step(pose, speed, dt, tiles.roadGraphNear()),
    });
    tiles.update(car.position);

    car.setSpeedLimit(speedLimitOf(settings)); // before the first frame

    const followCamera = createFollowCamera(camera, car.position, tiles.tallestBuilding, tiles.occluders);
    followCamera.setChaseOffset(chaseOffset(carModel.spec));
    followCamera.jumpTo(car.position, car.heading);
    tiles.onChange(() => followCamera.setTallestBuilding(tiles.tallestBuilding));
    const speedDisplay = createSpeedDisplay();

    // --- Stick to roads
    const carPose = () => ({ x: car.position.x, z: car.position.z, heading: car.heading });
    let toastTimer = 0;
    const toast = (text: string) => { // reuses the status box for a moment
      status.textContent = text;
      document.body.append(status);
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => status.remove(), 1500);
    };
    /** Turns Stick to roads on or off and returns the state it ended in: on needs a drivable road nearby. */
    function setRoadLock(on: boolean, { announce = false, quiet = false } = {}): boolean {
      if (on === roadLock.active) return on;
      if (on) {
        const snapped = roadLock.engage(carPose(), tiles.roadGraphNear());
        if (snapped) car.setPose(snapped.x, snapped.z, snapped.heading); // a few meters at most; the camera follows
        else if (!quiet) toast('No road nearby: Stick to roads stays off');
      } else {
        roadLock.disengage();
      }
      speedDisplay.setRoadLock(roadLock.active);
      if (announce && roadLock.active === on) toast(`Stick to roads ${on ? 'on' : 'off'}`);
      return roadLock.active;
    }
    /** After a teleport: puts the car back on the road it landed near. */
    function reseedRoadLock(): void {
      const snapped = roadLock.reset(carPose(), tiles.roadGraphNear());
      if (snapped) car.setPose(snapped.x, snapped.z, snapped.heading);
    }
    setRoadLock(roadLockOf(settings), { quiet: true });
    const compass = createCompass();
    const locationReadout = createLocationReadout();
    const streetReadout = createStreetReadout((x, z) => currentStreet(tiles.segmentsNear(), x, z));

    const tooltip = createBuildingTooltip();
    const picker = createBuildingPicker(camera, tiles.pickTargets);
    renderer.domElement.addEventListener('click', e => {
      const hit = picker.pick(e.clientX, e.clientY, renderer.domElement);
      if (hit) tooltip.open(buildingInfo(hit.feature), hit.point);
      else tooltip.close();
    });

    const settingsDialog = createSettingsDialog({
      initial: () => {
        const stored = loadSettings();
        return {
          startPoint: townSettings(stored, DEFAULT_TOWN).startPoint,
          speedLimitKmh: speedLimitOf(stored),
          vehicle: vehicleOf(stored),
          appearance: appearanceOf(stored),
          monitoring: perf.visible, // the panel itself is the truth, also when storage is blocked
          roadLock: roadLock.active,
        };
      },
      carPoint: () => fromWorld(car.position),
      preview: async point => {
        const world = toWorld(point);
        await tiles.ensureLoaded(world);
        return findStart(tiles.segmentsNear(world), world);
      },
      bounds: tiles.index.bbox,
      onOpenChange: open => onDialogOpenChange(open),
      onSave: ({ startPoint, speedLimitKmh, vehicle, appearance: newAppearance, monitoring, roadLock: wantsRoadLock }) => {
        const latest = loadSettings();
        const previous = townSettings(latest, DEFAULT_TOWN).startPoint;
        latest.towns[DEFAULT_TOWN] = { ...latest.towns[DEFAULT_TOWN], startPoint };
        latest.speedLimitKmh = speedLimitKmh;
        latest.vehicle = vehicle;
        latest.appearance = newAppearance;
        latest.monitoring = monitoring;
        setMonitoring(monitoring);
        latest.roadLock = setRoadLock(wantsRoadLock); // stays off, and is saved off, without a road nearby
        appearance = newAppearance;
        tiles.setAppearance(newAppearance);
        car.setSpeedLimit(speedLimitKmh);
        // Only a new starting point moves the car; a new limit alone must not interrupt driving.
        if (startPoint.x !== previous.x || startPoint.y !== previous.y) {
          const world = toWorld(startPoint);
          void tiles.ensureLoaded(world).then(() => { // load first, then place
            car.resetTo(findStart(tiles.segmentsNear(world), world));
            tiles.update(car.position);
            reseedRoadLock();
            followCamera.jumpTo(car.position, car.heading);
          });
        }
        if (vehicle !== carModel.spec.id) {
          carModel.setVehicle(vehicle);
          followCamera.setChaseOffset(chaseOffset(carModel.spec));
          // A bigger vehicle may not fit where the car stands: move it to the nearest road and stop there.
          // (Locked to a road, the road decides where the car can be, so it stays.)
          if (!roadLock.active && hitsVehicle(tiles.obstaclesNear(), car.position.x, car.position.z, car.heading, carModel.collision)) {
            car.resetTo(findStart(tiles.segmentsNear(), { x: car.position.x, z: car.position.z }));
            followCamera.jumpTo(car.position, car.heading);
          }
        }
        return saveSettings(latest); // false shows the "Couldn't save" note
      },
    });

    const onDialogOpenChange = (open: boolean) => {
      car.setInputEnabled(!open);
      followCamera.setInputEnabled(!open);
    };

    const favorites = createFavoritesDialog({
      load: () => favoritesOf(loadSettings(), DEFAULT_TOWN),
      store: list => saveFavorites(DEFAULT_TOWN, list),
      carPoint: () => fromWorld(car.position),
      streetHere: () => currentStreet(tiles.segmentsNear(), car.position.x, car.position.z),
      onOpenChange: onDialogOpenChange,
      goTo: async favorite => {
        const point = toWorld(favorite);
        await tiles.ensureLoaded(point); // load first, then place
        const road = findStart(tiles.segmentsNear(point), point);
        const blocked = hitsVehicle(tiles.obstaclesNear(point), point.x, point.z, road.heading, carModel.collision)
          || outsideDepth(tiles.index.bbox, point.x, point.z) > 0;
        car.resetTo(blocked || roadLock.active ? road : { x: point.x, z: point.z, heading: road.heading });
        tiles.update(car.position);
        reseedRoadLock();
        followCamera.jumpTo(car.position, car.heading);
      },
    });

    const tileMap = createTileMap({
      tiles,
      townId: DEFAULT_TOWN,
      carPose: () => ({ x: car.position.x, z: car.position.z, heading: car.heading }),
      onOpenChange: onDialogOpenChange,
    });

    addEventListener('keydown', e => {
      const plainKey = !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target);
      if (e.code === MONITORING_SHORTCUT && plainKey) {
        if (settingsDialog.isOpen) {
          settingsDialog.toggleMonitoring(); // applies on Save, like the other fields
        } else {
          const show = !perf.visible;
          setMonitoring(show);
          saveSettings({ ...loadSettings(), monitoring: show }); // if storage fails the panel still toggles
        }
      }
      if (e.code === ROAD_LOCK_SHORTCUT && plainKey) {
        if (settingsDialog.isOpen) {
          settingsDialog.toggleRoadLock(); // applies on Save, like the other fields
        } else if (!favorites.isOpen && !tileMap.isOpen) {
          const on = setRoadLock(!roadLock.active, { announce: true });
          saveSettings({ ...loadSettings(), roadLock: on }); // if storage fails the mode still toggles
        }
      }
      if (e.code === APPEARANCE_SHORTCUT && plainKey && !settingsDialog.isOpen && !favorites.isOpen && !tileMap.isOpen) {
        // Flips the saved building view; the dialog's Buildings choice stays the way to pick one explicitly.
        appearance = appearance === 'plain' ? 'realistic' : 'plain';
        tiles.setAppearance(appearance);
        saveSettings({ ...loadSettings(), appearance });
      }
      if (e.code === 'Escape' && !settingsDialog.isOpen && !favorites.isOpen && !tileMap.isOpen) tooltip.close();
    });

    // The graph is cached until the nearby tiles change, so this rebuilds the overlay once per change.
    function showRoadGraph(): void {
      const started = performance.now();
      const graph = tiles.roadGraphNear();
      if (graph === junctionDebug.shown) return;
      const built = performance.now() - started;
      junctionDebug.show(graph);
      const junctions = graph.zones.reduce((sum, zone) => sum + zone.members.length, 0);
      console.debug(`Road graph: ${graph.zones.length} zones from ${junctions} junctions, ${graph.segments.length} segments, built in ${built.toFixed(1)} ms`);
    }

    function tick(dt: number): void {
      perf.begin();
      tiles.update(car.position);
      car.update(dt);
      stage.moveSunTo(car.position);
      speedDisplay.update(car.speed);
      followCamera.update(dt, car.position, car.heading);
      compass.update(car.heading);
      streetReadout.update(dt, car.position);
      locationReadout.update(dt, car.position);
      tiles.updateLabels(car.heading);
      if (junctionDebug.visible) showRoadGraph();
      renderer.render(scene, camera);
      tooltip.update(camera); // after render, which refreshes the camera matrices
      perf.end();
    }

    const clock = new THREE.Clock();
    renderer.setAnimationLoop(() => tick(Math.min(clock.getDelta(), MAX_FRAME_TIME)));

    status.remove();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : 'Could not start the app.';
    console.error(error);
  }
}

void main();
