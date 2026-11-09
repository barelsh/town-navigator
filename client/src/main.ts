import * as THREE from 'three';
import './styles.css';
import { fetchTown } from './api/townApi.ts';
import { createFollowCamera } from './camera/followCamera.ts';
import { createCarController } from './car/carController.ts';
import { createCarModel } from './car/carModel.ts';
import { DEFAULT_TOWN } from './config.ts';
import { createCompass } from './hud/compass.ts';
import { createSpeedDisplay } from './hud/speed.ts';
import { createStreetReadout } from './hud/streetReadout.ts';
import { addGround, createStage } from './scene/stage.ts';
import { addBuildings } from './town/buildings.ts';
import { currentStreet, hitsBuilding, outsideTown } from './town/collision.ts';
import { addRoads } from './town/roads.ts';

const MAX_FRAME_TIME = 0.05; // seconds

async function main(): Promise<void> {
  const status = document.getElementById('status')!;

  try {
    const town = await fetchTown(DEFAULT_TOWN);

    const stage = createStage();
    const { renderer, scene, camera } = stage;

    addGround(scene, town.bbox);
    const roads = addRoads(scene, renderer, town);
    const { obstacles, tallestBuilding } = addBuildings(scene, town);

    const carModel = createCarModel();
    scene.add(carModel.group);
    const car = createCarController(carModel, roads.start, (x, z) =>
      hitsBuilding(obstacles, x, z) || outsideTown(town.bbox, x, z));

    const followCamera = createFollowCamera(camera, car.position, tallestBuilding);
    const speedDisplay = createSpeedDisplay();
    const compass = createCompass();
    const streetReadout = createStreetReadout((x, z) => currentStreet(roads.segments, x, z));

    function tick(dt: number): void {
      car.update(dt);
      stage.moveSunTo(car.position);
      speedDisplay.update(car.speed);
      followCamera.update(dt, car.position, car.heading);
      compass.update(car.heading);
      streetReadout.update(dt, car.position);
      roads.labels.update(car.heading);
      renderer.render(scene, camera);
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
