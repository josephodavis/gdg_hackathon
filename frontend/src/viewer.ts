import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Payload } from './payload';

// Photo colors are sRGB; pass everything through untouched.
THREE.ColorManagement.enabled = false;

export class Viewer {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(60, 1, 0.01, 1000);
  readonly renderer: THREE.WebGLRenderer;
  readonly labels = new CSS2DRenderer();
  readonly controls: OrbitControls;
  readonly frustums = new THREE.Group();
  points: THREE.Points | null = null;
  grid: THREE.GridHelper | null = null;
  payload: Payload | null = null;
  /** Robust (1–99 pct) bounds of the cloud. */
  bounds = new THREE.Box3();
  diag = 1;
  floorY = 0;
  private baseSize = 0.01;
  private sizeMul = 2;
  private frameCbs: Array<() => void> = [];
  private loadCbs: Array<() => void> = [];

  readonly container: HTMLElement;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x14161a);
    container.appendChild(this.renderer.domElement);
    this.labels.domElement.className = 'labels';
    container.appendChild(this.labels.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;

    this.scene.add(this.frustums);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  onFrame(cb: () => void) {
    this.frameCbs.push(cb);
  }
  onLoad(cb: () => void) {
    this.loadCbs.push(cb);
  }

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  private tick() {
    this.controls.update();
    for (const cb of this.frameCbs) cb();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  load(p: Payload) {
    this.clear();
    this.payload = p;
    const { header, positions, colors } = p;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
    geom.computeBoundingSphere();

    this.bounds = robustBounds(positions);
    const size = this.bounds.getSize(new THREE.Vector3());
    this.diag = Math.max(size.length(), 0.1);
    this.floorY = header.floorY ?? this.bounds.min.y;
    // ~ average point spacing for a room-sized surface cloud
    this.baseSize = Math.max(this.diag * 0.0015, 0.002);

    const mat = new THREE.PointsMaterial({ size: this.baseSize * this.sizeMul, vertexColors: true, sizeAttenuation: true });
    this.points = new THREE.Points(geom, mat);
    this.scene.add(this.points);

    this.buildFrustums(p);
    this.buildGrid();
    this.frame();
    for (const cb of this.loadCbs) cb();
  }

  clear() {
    if (this.points) {
      this.scene.remove(this.points);
      this.points.geometry.dispose();
      (this.points.material as THREE.Material).dispose();
      this.points = null;
    }
    for (const c of [...this.frustums.children]) {
      this.frustums.remove(c);
      (c as THREE.LineSegments).geometry.dispose();
    }
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.dispose();
      this.grid = null;
    }
    this.payload = null;
  }

  private buildFrustums(p: Payload) {
    const d = Math.min(0.25, this.diag * 0.03);
    const verts: number[] = [];
    const m = new THREE.Matrix4();
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(m);
    const seg = (a: THREE.Vector3, b: THREE.Vector3) => verts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    for (const cam of p.header.cameras) {
      m.set(...(cam.c2w as Parameters<THREE.Matrix4['set']>));
      const o = v(0, 0, 0);
      const corner = (u: number, w: number) => v(((u - cam.cx) / cam.fx) * d, ((w - cam.cy) / cam.fy) * d, d);
      const tl = corner(0, 0), tr = corner(cam.width, 0), br = corner(cam.width, cam.height), bl = corner(0, cam.height);
      seg(o, tl); seg(o, tr); seg(o, br); seg(o, bl);
      seg(tl, tr); seg(tr, br); seg(br, bl); seg(bl, tl);
      // little "up" triangle above the top edge (image -y)
      const up = v(0, ((-cam.cy) / cam.fy) * d * 1.35, d);
      seg(tl, up); seg(up, tr);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    this.frustums.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xffa630 })));
  }

  private buildGrid() {
    const size = this.bounds.getSize(new THREE.Vector3());
    const span = Math.ceil(Math.max(size.x, size.z) + 1);
    const grid = new THREE.GridHelper(span, span * 2, 0x4a5160, 0x2c313a);
    const c = this.bounds.getCenter(new THREE.Vector3());
    grid.position.set(c.x, this.floorY, c.z);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.6;
    this.grid = grid;
    this.scene.add(grid);
  }

  /** 'photo' = stand where the first photo was taken (most recognizable); 'overview' = from above. */
  frame(mode: 'photo' | 'overview' = 'photo') {
    const c = this.bounds.getCenter(new THREE.Vector3());
    this.camera.near = this.diag / 2000;
    this.camera.far = this.diag * 50;
    const cam0 = this.payload?.header.cameras[0];
    if (mode === 'photo' && cam0) {
      const m = new THREE.Matrix4().set(...(cam0.c2w as Parameters<THREE.Matrix4['set']>));
      const pos = new THREE.Vector3().setFromMatrixPosition(m);
      const fwd = new THREE.Vector3().setFromMatrixColumn(m, 2).normalize();
      this.camera.position.copy(pos).addScaledVector(fwd, -Math.min(0.5, this.diag * 0.05));
      this.controls.target.copy(pos).addScaledVector(fwd, Math.max(1, this.diag * 0.3));
    } else {
      const dir = new THREE.Vector3(0.35, 1, 0.6).normalize();
      this.camera.position.copy(c).addScaledVector(dir, this.diag * 1.0);
      this.controls.target.copy(c);
    }
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  setPointSize(mul: number) {
    this.sizeMul = mul;
    if (this.points) (this.points.material as THREE.PointsMaterial).size = this.baseSize * mul;
  }
  setFrustumsVisible(v: boolean) {
    this.frustums.visible = v;
  }
  setGridVisible(v: boolean) {
    if (this.grid) this.grid.visible = v;
  }
}

function robustBounds(pos: Float32Array): THREE.Box3 {
  const n = pos.length / 3;
  const step = Math.max(1, Math.floor(n / 20000));
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  for (let i = 0; i < n; i += step) {
    xs.push(pos[i * 3]); ys.push(pos[i * 3 + 1]); zs.push(pos[i * 3 + 2]);
  }
  const q = (a: number[], t: number) => a[Math.min(a.length - 1, Math.floor(t * a.length))];
  for (const a of [xs, ys, zs]) a.sort((p, r) => p - r);
  return new THREE.Box3(
    new THREE.Vector3(q(xs, 0.01), q(ys, 0.01), q(zs, 0.01)),
    new THREE.Vector3(q(xs, 0.99), q(ys, 0.99), q(zs, 0.99)),
  );
}
