import * as THREE from 'three';
import './styles.css';
import { fetchRoute, fetchTileIndex, fetchTown } from './api/townApi.ts';
import { createFollowCamera } from './camera/followCamera.ts';
import { createCarController } from './car/carController.ts';
import { createCarModel } from './car/carModel.ts';
import { createRoadLock, type LockSnapshot } from './car/roadLock.ts';
import { createDebugLog } from './debug/debugLog.ts';
import { chaseOffset } from './car/vehicles.ts';
import { APPEARANCE_SHORTCUT, DEFAULT_TOWN, MONITORING_SHORTCUT, ROAD_LOCK_SHORTCUT, TOWN_LOAD_MODE } from './config.ts';
import { createBuildingTooltip } from './hud/buildingTooltip.ts';
import { createCompass } from './hud/compass.ts';
import { createFavoritesDialog } from './hud/favoritesDialog.ts';
import { createJunctionDebug } from './hud/junctionDebug.ts';
import { createTurnIntent } from './hud/turnIntent.ts';
import { createSpeedDisplay } from './hud/speed.ts';
import { createPerfMonitor } from './hud/perfMonitor.ts';
import { createSettingsDialog, isTyping } from './hud/settingsDialog.ts';
import { createTileMap } from './hud/tileMap.ts';
import { createLocationReadout } from './hud/location.ts';
import { createNavCard } from './hud/navCard.ts';
import { createNavigationDialog } from './hud/navigationDialog.ts';
import { createNavigation } from './nav/navigation.ts';
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
    const debugLog = import.meta.env.DEV ? createDebugLog() : null; // flight recorder: press L to save it to logs/

    const settings = loadSettings();
    const perf = createPerfMonitor(renderer);
    const junctionDebug = createJunctionDebug(scene); // the road graph overlay shows with the panel
    const setMonitoring = (visible: boolean) => {
      perf.setVisible(visible);
      junctionDebug.setVisible(visible);
      debugLog?.event('monitoring', { on: visible });
    };
    setMonitoring(monitoringEnabled(settings));
    let appearance = appearanceOf(settings);
    let speedLimitKmh = speedLimitOf(settings);
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
    // The road graph around the car. Rebuilt when the nearby tiles change, so a rebuild is logged with how long it took.
    let lastGraph: ReturnType<typeof tiles.roadGraphNear> | null = null;
    const graphNear = () => {
      const started = performance.now();
      const graph = tiles.roadGraphNear();
      if (graph !== lastGraph) {
        lastGraph = graph;
        debugLog?.event('graph', { ms: +(performance.now() - started).toFixed(2), segments: graph.segments.length, zones: graph.zones.length });
      }
      return graph;
    };
    const roadLock = createRoadLock({ onEvent: debugLog ? (kind, data) => debugLog.event(`lock.${kind}`, data) : undefined });
    const car = createCarController(carModel, findStart(tiles.segmentsNear(target), target), (x, z, heading) =>
      Math.max(vehicleOverlap(tiles.obstaclesNear(), x, z, heading, carModel.collision), outsideDepth(tiles.index.bbox, x, z)), {
      get active() { return roadLock.active; },
      get mode() { return roadLock.mode; },
      get hold() { return roadLock.hold; },
      step: (pose, speed, dt) => roadLock.step(pose, speed, dt, graphNear()),
      observe: (pose, speed, dt) => roadLock.observe(pose, speed, dt, graphNear()),
      get intent() { return roadLock.intent; },
      get speedCap() { return roadLock.speedCap; },
      press: side => roadLock.press(side),
      tap: side => roadLock.tap(side),
      steerHeld: held => roadLock.steerHeld(held),
      autoSteer: (pose, speed) => roadLock.autoSteer(pose, speed),
      arrow: () => roadLock.arrow(),
    });
    tiles.update(car.position);

    car.setSpeedLimit(speedLimitOf(settings)); // before the first frame

    const followCamera = createFollowCamera(camera, car.position, tiles.tallestBuilding, tiles.occluders);
    followCamera.setChaseOffset(chaseOffset(carModel.spec));
    followCamera.jumpTo(car.position, car.heading);
    tiles.onChange(() => followCamera.setTallestBuilding(tiles.tallestBuilding));
    tiles.onChange(() => {
      if (!debugLog) return;
      const counts = { loaded: 0, loading: 0, failed: 0 };
      for (const state of tiles.statuses().values()) counts[state]++;
      debugLog.event('tiles', counts);
    });
    const speedDisplay = createSpeedDisplay();
    const turnIntent = createTurnIntent(scene);

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
        const snapped = roadLock.engage(carPose(), graphNear());
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
      const snapped = roadLock.reset(carPose(), graphNear());
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
      onSave: ({ startPoint, speedLimitKmh: newLimitKmh, vehicle, appearance: newAppearance, monitoring, roadLock: wantsRoadLock }) => {
        debugLog?.event('settingsSaved', { startPoint, speedLimitKmh: newLimitKmh, vehicle, appearance: newAppearance, monitoring, roadLock: wantsRoadLock });
        const latest = loadSettings();
        const previous = townSettings(latest, DEFAULT_TOWN).startPoint;
        latest.towns[DEFAULT_TOWN] = { ...latest.towns[DEFAULT_TOWN], startPoint };
        latest.speedLimitKmh = newLimitKmh;
        speedLimitKmh = newLimitKmh;
        latest.vehicle = vehicle;
        latest.appearance = newAppearance;
        latest.monitoring = monitoring;
        setMonitoring(monitoring);
        latest.roadLock = setRoadLock(wantsRoadLock); // stays off, and is saved off, without a road nearby
        appearance = newAppearance;
        tiles.setAppearance(newAppearance);
        car.setSpeedLimit(newLimitKmh);
        // Only a new starting point moves the car; a new limit alone must not interrupt driving.
        if (startPoint.x !== previous.x || startPoint.y !== previous.y) {
          const world = toWorld(startPoint);
          void tiles.ensureLoaded(world).then(() => { // load first, then place
            car.resetTo(findStart(tiles.segmentsNear(world), world));
            tiles.update(car.position);
            reseedRoadLock();
            followCamera.jumpTo(car.position, car.heading);
            navigation.reroute('teleport', true);
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
      debugLog?.event('dialog', { open });
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
        debugLog?.event('goTo', { favorite: favorite.name, x: favorite.x, y: favorite.y });
        const point = toWorld(favorite);
        await tiles.ensureLoaded(point); // load first, then place
        const road = findStart(tiles.segmentsNear(point), point);
        const blocked = hitsVehicle(tiles.obstaclesNear(point), point.x, point.z, road.heading, carModel.collision)
          || outsideDepth(tiles.index.bbox, point.x, point.z) > 0;
        car.resetTo(blocked || roadLock.active ? road : { x: point.x, z: point.z, heading: road.heading });
        tiles.update(car.position);
        reseedRoadLock();
        followCamera.jumpTo(car.position, car.heading);
        navigation.reroute('teleport', true);
      },
    });

    // --- Navigation (guidance only: the route never steers the car)
    const navigation = createNavigation({
      requestRoute: (body, signal) => fetchRoute(DEFAULT_TOWN, body, signal),
      pose: carPose,
      onEvent: debugLog ? (kind, data) => debugLog.event(kind, data) : undefined,
    });
    const navCard = createNavCard({ onStop: () => navigation.stop() });
    const navigationDialog = createNavigationDialog({
      load: () => favoritesOf(loadSettings(), DEFAULT_TOWN),
      carPoint: () => fromWorld(car.position),
      active: () => {
        const destination = navigation.destination;
        const { state } = navigation; // arrived or failed: done, even while its message still shows
        if (!destination || (state !== 'routing' && state !== 'active' && state !== 'rerouting')) return null;
        const route = navigation.route;
        return { id: destination.id, name: destination.name, left: route ? Math.max(0, route.distance - navigation.along) : null };
      },
      navigate: favorite => navigation.start(favorite),
      stop: () => navigation.stop(),
      openFavorites: () => favorites.open(),
      onOpenChange: onDialogOpenChange,
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
      if (e.code === 'KeyL' && plainKey && debugLog) void saveDebugLog();
      if (e.code === ROAD_LOCK_SHORTCUT && plainKey) {
        if (settingsDialog.isOpen) {
          settingsDialog.toggleRoadLock(); // applies on Save, like the other fields
        } else if (!favorites.isOpen && !tileMap.isOpen && !navigationDialog.isOpen) {
          const on = setRoadLock(!roadLock.active, { announce: true });
          saveSettings({ ...loadSettings(), roadLock: on }); // if storage fails the mode still toggles
        }
      }
      if (e.code === APPEARANCE_SHORTCUT && plainKey && !settingsDialog.isOpen && !favorites.isOpen && !tileMap.isOpen && !navigationDialog.isOpen) {
        // Flips the saved building view; the dialog's Buildings choice stays the way to pick one explicitly.
        appearance = appearance === 'plain' ? 'realistic' : 'plain';
        debugLog?.event('appearance', { appearance });
        tiles.setAppearance(appearance);
        saveSettings({ ...loadSettings(), appearance });
      }
      if (e.code === 'Escape' && !settingsDialog.isOpen && !favorites.isOpen && !tileMap.isOpen && !navigationDialog.isOpen) tooltip.close();
    });

    /** Development: the L key writes the flight recorder to logs/. */
    async function saveDebugLog(): Promise<void> {
      if (!debugLog) return;
      const gl = renderer.getContext();
      const gpu = gl.getExtension('WEBGL_debug_renderer_info');
      const file = await debugLog.save({
        gpu: gpu ? gl.getParameter(gpu.UNMASKED_RENDERER_WEBGL) : null,
        pixelRatio: renderer.getPixelRatio(),
        settings: loadSettings(),
        town: DEFAULT_TOWN, loadMode: TOWN_LOAD_MODE, appearance,
        vehicle: carModel.spec.id, monitoring: perf.visible,
        lock: { active: roadLock.active, mode: roadLock.mode },
        car: { x: car.position.x, z: car.position.z, heading: car.heading, speed: car.speed },
      });
      console.info(`Debug log saved: ${file}`);
      toast(file === 'download' ? 'Debug log downloaded' : `Debug log saved: ${file}`);
    }

    // The graph is cached until the nearby tiles change, so this rebuilds the overlay once per change.
    function showRoadGraph(): void {
      const started = performance.now();
      const graph = graphNear();
      if (graph === junctionDebug.shown) return;
      const built = performance.now() - started;
      const shownAt = performance.now();
      junctionDebug.show(graph);
      debugLog?.event('overlay', { ms: +(performance.now() - shownAt).toFixed(2) });
      const junctions = graph.zones.reduce((sum, zone) => sum + zone.members.length, 0);
      console.debug(`Road graph: ${graph.zones.length} zones from ${junctions} junctions, ${graph.segments.length} segments, built in ${built.toFixed(1)} ms`);
    }

    const lockView: LockSnapshot = {
      active: 0, mode: 0, hold: 0, candHeading: NaN, candFlow: 0, zoneX: 0, zoneZ: 0, zoneR: 0,
      trackAx: NaN, trackAz: NaN, trackBx: NaN, trackBz: NaN, trackT: NaN, trackDir: 0,
      heading: 0, lateral: 0, offLen: 0, ease: 0, lastZoneR: 0,
    };
    let lastTick = 0, heapMB = 0, frameNumber = 0;

    /** Writes one frame to the flight recorder: stage timings, the car, the lock's insides, the camera and the renderer. */
    function recordFrame(dt: number, marks: number[]): void {
      if (!debugLog) return;
      const s = debugLog.sample, [t0, t1, t2, t3, t4, t5, t6] = marks;
      s.t = t0; s.interval = lastTick ? t0 - lastTick : 0; s.dt = dt * 1000; lastTick = t0;
      s.msTiles = t1 - t0; s.msCar = t2 - t1; s.msCamera = t3 - t2; s.msHud = t4 - t3; s.msRender = t5 - t4; s.msTotal = t6 - t0;
      s.x = car.position.x; s.z = car.position.z; s.heading = car.heading; s.speed = car.speed;
      roadLock.inspect(lockView);
      s.lockActive = lockView.active; s.lockMode = lockView.mode; s.hold = lockView.hold;
      s.candHeading = lockView.candHeading; s.candFlow = lockView.candFlow;
      s.zoneX = lockView.zoneX; s.zoneZ = lockView.zoneZ; s.zoneR = lockView.zoneR; s.lastZoneR = lockView.lastZoneR;
      s.trackAx = lockView.trackAx; s.trackAz = lockView.trackAz; s.trackBx = lockView.trackBx; s.trackBz = lockView.trackBz;
      s.trackT = lockView.trackT; s.trackDir = lockView.trackDir;
      s.lockHeading = lockView.heading; s.lateral = lockView.lateral; s.offLen = lockView.offLen; s.ease = lockView.ease;
      s.camX = camera.position.x; s.camY = camera.position.y; s.camZ = camera.position.z;
      s.camToCar = camera.position.distanceTo(car.position);
      s.calls = renderer.info.render.calls; s.triangles = renderer.info.render.triangles;
      s.geometries = renderer.info.memory.geometries; s.textures = renderer.info.memory.textures;
      if ((frameNumber++ & 15) === 0) { // the heap size is only read now and then: reading it allocates
        heapMB = ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576;
      }
      s.heapMB = heapMB;
      s.overlay = junctionDebug.visible ? 1 : 0;
      debugLog.commit();
    }
    function tick(dt: number): void {
      const t0 = performance.now();
      perf.begin();
      tiles.update(car.position);
      const t1 = performance.now();
      car.update(dt);
      const t2 = performance.now();
      stage.moveSunTo(car.position);
      speedDisplay.update(car.speed);
      followCamera.update(dt, car.position, car.heading);
      const t3 = performance.now();
      compass.update(car.heading);
      streetReadout.update(dt, car.position);
      locationReadout.update(dt, car.position);
      tiles.updateLabels(car.heading);
      speedDisplay.setRoadLock(roadLock.active, roadLock.mode === 'free');
      const choosing = roadLock.active && car.speed >= 0; // reversing ignores the queued turn
      turnIntent.update(choosing ? roadLock.intent : null, choosing ? roadLock.arrow() : null, t0 / 1000);
      navigation.update(dt, carPose(), car.speed, speedLimitKmh / 3.6);
      navCard.update(dt, navigation.view());
      navigationDialog.setActive(navigation.state !== 'idle');
      if (junctionDebug.visible) {
        showRoadGraph();
        junctionDebug.setCandidate(roadLock.candidate());
      }
      const t4 = performance.now();
      renderer.render(scene, camera);
      const t5 = performance.now();
      tooltip.update(camera); // after render, which refreshes the camera matrices
      perf.end();
      if (debugLog) recordFrame(dt, [t0, t1, t2, t3, t4, t5, performance.now()]);
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
