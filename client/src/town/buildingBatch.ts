import * as THREE from 'three';

interface Bucket { positions: number[]; normals: number[]; uvs: number[]; colors: number[] }

/** Collects the buildings of one chunk per material, then turns each material into one mesh. */
export function createBuildingBatch() {
  const buckets = new Map<THREE.Material, Bucket>();

  return {
    /** Copies each material group of a world-space geometry into its material's bucket,
     *  tinted with that group's color. */
    add(geometry: THREE.BufferGeometry, materials: THREE.Material[], colors: THREE.Color[]): void {
      const source = geometry.index ? geometry.toNonIndexed() : geometry;
      const { position, normal, uv } = source.attributes;
      const groups = source.groups.length ? source.groups : [{ start: 0, count: position.count, materialIndex: 0 }];
      for (const { start, count, materialIndex = 0 } of groups) {
        const material = materials[materialIndex], color = colors[materialIndex];
        let bucket = buckets.get(material);
        if (!bucket) buckets.set(material, bucket = { positions: [], normals: [], uvs: [], colors: [] });
        for (let i = start; i < start + count; i++) {
          bucket.positions.push(position.getX(i), position.getY(i), position.getZ(i));
          bucket.normals.push(normal.getX(i), normal.getY(i), normal.getZ(i));
          bucket.uvs.push(uv.getX(i), uv.getY(i));
          bucket.colors.push(color.r, color.g, color.b);
        }
      }
      if (source !== geometry) source.dispose();
    },

    /** One mesh per material, added to the parent. Returned so the chunk can dispose their geometries. */
    finish(parent: THREE.Object3D): THREE.Mesh[] {
      const meshes: THREE.Mesh[] = [];
      for (const [material, b] of buckets) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
        geometry.setAttribute('normal', new THREE.Float32BufferAttribute(b.normals, 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute(b.uvs, 2));
        geometry.setAttribute('color', new THREE.Float32BufferAttribute(b.colors, 3));
        const mesh = new THREE.Mesh(geometry, material);
        mesh.castShadow = mesh.receiveShadow = true;
        parent.add(mesh);
        meshes.push(mesh);
      }
      buckets.clear();
      return meshes;
    },
  };
}

export type BuildingBatch = ReturnType<typeof createBuildingBatch>;
