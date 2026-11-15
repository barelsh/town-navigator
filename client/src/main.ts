import * as THREE from 'three';
import './styles.css';
import { fetchTown } from './api/townApi.ts';
import { createFollowCamera } from './camera/followCamera.ts';
import { createCarController } from './car/carController.ts';
import { createCarModel } from './car/carModel.ts';
import { DEFAULT_TOWN } from './config.ts';
import { createBuildingTooltip } from './hud/buildingTooltip.ts';
import { createCompass } from './hud/compass.ts';
import { createSpeedDisplay } from './hud/speed.ts';
import { createSettingsDialog } from './hud/settingsDialog.ts';
import { createStreetReadout } from './hud/streetReadout.ts';
import { addGround, createStage } from './scene/stage.ts';
import { buildingInfo } from './town/buildingInfo.ts';
import { createBuildingPicker } from './town/buildingPicker.ts';
import { addBuildings } from './town/buildings.ts';
import { currentStreet, hitsBuilding, outsideTown } from './town/collision.ts';
import { fromWorld, loadSettings, saveSettings, speedLimitOf, toWorld, townSettings } from './settings/settingsStore.ts';
import { addRoads, findStart } from './town/roads.ts';

const MAX_FRAME_TIME = 0.05; // seconds

async function main(): Promise<void> {
  const status = document.getElementById('status')!;

  try {
    const town = await fetchTown(DEFAULT_TOWN);

    const stage = createStage();
    const { renderer, scene, camera } = stage;

    addGround(scene, town.bbox);
    const roads = addRoads(scene, renderer, town);
    const { obstacles, tallestBuilding, pickTargets } = addBuildings(scene, town);

    const carModel = createCarModel();
    scene.add(carModel.group);
    const settings = loadSettings();
    const target = toWorld(townSettings(settings, DEFAULT_TOWN).startPoint);
    const car = createCarController(carModel, findStart(roads.segments, target), (x, z) =>
      hitsBuilding(obstacles, x, z) || outsideTown(town.bbox, x, z));

    car.setSpeedLimit(speedLimitOf(settings)); // before the first frame

    const occluders = [...pickTargets.keys()].filter(object => object instanceof THREE.Mesh);
    const followCamera = createFollowCamera(camera, car.position, tallestBuilding, occluders);
    const speedDisplay = createSpeedDisplay();
    const compass = createCompass();
    const streetReadout = createStreetReadout((x, z) => currentStreet(roads.segments, x, z));

    const tooltip = createBuildingTooltip();
    const picker = createBuildingPicker(camera, pickTargets);
    renderer.domElement.addEventListener('click', e => {
      const hit = picker.pick(e.clientX, e.clientY, renderer.domElement);
      if (hit) tooltip.open(buildingInfo(hit.feature), hit.point);
      else tooltip.close();
    });

    const settingsDialog = createSettingsDialog({
      initial: () => {
        const stored = loadSettings();
        return { startPoint: townSettings(stored, DEFAULT_TOWN).startPoint, speedLimitKmh: speedLimitOf(stored) };
      },
      carPoint: () => fromWorld(car.position),
      preview: point => findStart(roads.segments, toWorld(point)),
      bounds: town.bbox,
      onOpenChange: open => {
        car.setInputEnabled(!open);
        followCamera.setInputEnabled(!open);
      },
      onSave: ({ startPoint, speedLimitKmh }) => {
        const latest = loadSettings();
        const previous = townSettings(latest, DEFAULT_TOWN).startPoint;
        latest.towns[DEFAULT_TOWN] = { startPoint };
        latest.speedLimitKmh = speedLimitKmh;
        car.setSpeedLimit(speedLimitKmh);
        // Only a new starting point moves the car; a new limit alone must not interrupt driving.
        if (startPoint.x !== previous.x || startPoint.y !== previous.y) {
          car.resetTo(findStart(roads.segments, toWorld(startPoint)));
          followCamera.jumpTo(car.position, car.heading);
        }
        return saveSettings(latest); // false shows the "Couldn't save" note
      },
    });

    addEventListener('keydown', e => {
      if (e.code === 'Escape' && !settingsDialog.isOpen) tooltip.close();
    });

    function tick(dt: number): void {
      car.update(dt);
      stage.moveSunTo(car.position);
      speedDisplay.update(car.speed);
      followCamera.update(dt, car.position, car.heading);
      compass.update(car.heading);
      streetReadout.update(dt, car.position);
      roads.labels.update(car.heading);
      renderer.render(scene, camera);
      tooltip.update(camera); // after render, which refreshes the camera matrices
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
