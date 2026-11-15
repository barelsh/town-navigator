import * as THREE from 'three';
import './styles.css';
import { fetchTown } from './api/townApi.ts';
import { createFollowCamera } from './camera/followCamera.ts';
import { createCarController } from './car/carController.ts';
import { createCarModel } from './car/carModel.ts';
import { chaseOffset } from './car/vehicles.ts';
import { APPEARANCE_SHORTCUT, DEFAULT_TOWN } from './config.ts';
import { createBuildingTooltip } from './hud/buildingTooltip.ts';
import { createCompass } from './hud/compass.ts';
import { createSpeedDisplay } from './hud/speed.ts';
import { createSettingsDialog } from './hud/settingsDialog.ts';
import { createStreetReadout } from './hud/streetReadout.ts';
import { addGround, createStage } from './scene/stage.ts';
import { buildingInfo } from './town/buildingInfo.ts';
import { createBuildingPicker } from './town/buildingPicker.ts';
import { addBuildings } from './town/buildings.ts';
import { currentStreet, hitsVehicle, outsideDepth, vehicleOverlap } from './town/collision.ts';
import { fromWorld, loadSettings, saveSettings, speedLimitOf, appearanceOf, toWorld, townSettings, vehicleOf } from './settings/settingsStore.ts';
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
    const { obstacles, tallestBuilding, pickTargets, setAppearance } = addBuildings(scene, town);

    const settings = loadSettings();
    let appearance = appearanceOf(settings);
    setAppearance(appearance); // before the first frame
    const carModel = createCarModel(vehicleOf(settings));
    scene.add(carModel.group);
    const target = toWorld(townSettings(settings, DEFAULT_TOWN).startPoint);
    const car = createCarController(carModel, findStart(roads.segments, target), (x, z, heading) =>
      Math.max(vehicleOverlap(obstacles, x, z, heading, carModel.collision), outsideDepth(town.bbox, x, z)));

    car.setSpeedLimit(speedLimitOf(settings)); // before the first frame

    const occluders = [...pickTargets.keys()].filter(object => object instanceof THREE.Mesh);
    const followCamera = createFollowCamera(camera, car.position, tallestBuilding, occluders);
    followCamera.setChaseOffset(chaseOffset(carModel.spec));
    followCamera.jumpTo(car.position, car.heading);
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
        return {
          startPoint: townSettings(stored, DEFAULT_TOWN).startPoint,
          speedLimitKmh: speedLimitOf(stored),
          vehicle: vehicleOf(stored),
          appearance: appearanceOf(stored),
        };
      },
      carPoint: () => fromWorld(car.position),
      preview: point => findStart(roads.segments, toWorld(point)),
      bounds: town.bbox,
      onOpenChange: open => {
        car.setInputEnabled(!open);
        followCamera.setInputEnabled(!open);
      },
      onSave: ({ startPoint, speedLimitKmh, vehicle, appearance: newAppearance }) => {
        const latest = loadSettings();
        const previous = townSettings(latest, DEFAULT_TOWN).startPoint;
        latest.towns[DEFAULT_TOWN] = { startPoint };
        latest.speedLimitKmh = speedLimitKmh;
        latest.vehicle = vehicle;
        latest.appearance = newAppearance;
        appearance = newAppearance;
        setAppearance(newAppearance);
        car.setSpeedLimit(speedLimitKmh);
        // Only a new starting point moves the car; a new limit alone must not interrupt driving.
        if (startPoint.x !== previous.x || startPoint.y !== previous.y) {
          car.resetTo(findStart(roads.segments, toWorld(startPoint)));
          followCamera.jumpTo(car.position, car.heading);
        }
        if (vehicle !== carModel.spec.id) {
          carModel.setVehicle(vehicle);
          followCamera.setChaseOffset(chaseOffset(carModel.spec));
          // A bigger vehicle may not fit where the car stands: move it to the nearest road and stop there.
          if (hitsVehicle(obstacles, car.position.x, car.position.z, car.heading, carModel.collision)) {
            car.resetTo(findStart(roads.segments, { x: car.position.x, z: car.position.z }));
            followCamera.jumpTo(car.position, car.heading);
          }
        }
        return saveSettings(latest); // false shows the "Couldn't save" note
      },
    });

    addEventListener('keydown', e => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.code === APPEARANCE_SHORTCUT && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !typing && !settingsDialog.isOpen) {
        // Flips the saved building view; the dialog's Buildings choice stays the way to pick one explicitly.
        appearance = appearance === 'plain' ? 'realistic' : 'plain';
        setAppearance(appearance);
        saveSettings({ ...loadSettings(), appearance });
      }
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
