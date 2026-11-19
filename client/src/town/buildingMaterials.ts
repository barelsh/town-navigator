import * as THREE from 'three';
import { duplexWindowTexture, roofTexture, windowTexture, ROOF_LIFT, WALL_LIFT } from './houseModel.ts';

/** Materials shared by every building of every tile. Colors come from the vertex color attribute. */
export interface BuildingMaterialKit {
  blockRoof: THREE.MeshLambertMaterial;
  blockWall: THREE.MeshLambertMaterial;
  houseRoof: THREE.MeshLambertMaterial;
  houseWindows: THREE.MeshLambertMaterial;
  duplexWindows: THREE.MeshLambertMaterial;
  housePlaster: THREE.MeshLambertMaterial;
}

/** A material tinted by the vertex color attribute, including its emissive lift. */
function tintedEmissive(map: THREE.Texture | null, lift: number): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({
    map, color: 0xffffff, vertexColors: true,
    emissive: 0xffffff, emissiveIntensity: lift, emissiveMap: map,
  });
  material.onBeforeCompile = shader => {
    shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>',
      '#include <emissivemap_fragment>\n totalEmissiveRadiance *= vColor;');
  };
  material.customProgramCacheKey = () => 'tinted-emissive';
  return material;
}

export function createBuildingMaterialKit(): BuildingMaterialKit {
  return {
    blockRoof: new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }),
    blockWall: new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true }),
    houseRoof: tintedEmissive(roofTexture(), ROOF_LIFT),
    houseWindows: tintedEmissive(windowTexture(false), WALL_LIFT),
    duplexWindows: tintedEmissive(duplexWindowTexture(), WALL_LIFT),
    housePlaster: tintedEmissive(null, WALL_LIFT),
  };
}
