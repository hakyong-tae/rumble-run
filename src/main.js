import * as THREE from 'three'

// ─── User profile & settings (localStorage persistence) ─────────────────────
const STORAGE_KEY = 'marble-run-v8'
const DEFAULT_PROFILE = {
  coins: 0,
  ownedSkins: ['classic'],
  equippedSkin: 'classic',
  bestRanks: [],   // last N race results (1..8)
  seenTutorial: false,
  settings: {
    sfxVolume: 0.7,
    bgmVolume: 0.4,
    shake: true,
    shadows: true,
    markers: true,
  },
}
let profile = (() => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return structuredClone(DEFAULT_PROFILE)
    const p = JSON.parse(raw)
    return { ...structuredClone(DEFAULT_PROFILE), ...p,
             settings: { ...DEFAULT_PROFILE.settings, ...(p.settings || {}) } }
  } catch (e) { return structuredClone(DEFAULT_PROFILE) }
})()
function saveProfile() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(profile)) } catch (e) {}
}
function resetProfile() {
  profile = structuredClone(DEFAULT_PROFILE)
  saveProfile()
}

// ─── SFX (Web Audio synthesis — original Unity assets are locked in .data) ──
const SFX = (() => {
  let ctx = null
  function ac() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)()
    return ctx
  }
  function tone({ freq = 440, freq2 = null, dur = 0.15, type = 'square', vol = 0.18, attack = 0.005, decay = null }) {
    const v = vol * profile.settings.sfxVolume
    if (v < 0.001) return
    const c = ac()
    const t0 = c.currentTime
    const osc = c.createOscillator()
    const g = c.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(freq, t0)
    if (freq2 != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freq2), t0 + dur)
    const d = decay ?? dur
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(v, t0 + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + d)
    osc.connect(g); g.connect(c.destination)
    osc.start(t0); osc.stop(t0 + d + 0.02)
  }
  function noise({ dur = 0.2, vol = 0.15, hp = 600 }) {
    const v = vol * profile.settings.sfxVolume
    if (v < 0.001) return
    const c = ac()
    const len = Math.floor(c.sampleRate * dur)
    const buf = c.createBuffer(1, len, c.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len)
    const src = c.createBufferSource(); src.buffer = buf
    const filt = c.createBiquadFilter(); filt.type = 'highpass'; filt.frequency.value = hp
    const g = c.createGain(); g.gain.value = v
    src.connect(filt); filt.connect(g); g.connect(c.destination)
    src.start()
  }
  return {
    coin:    () => tone({ freq: 880,  freq2: 1760, dur: 0.10, type: 'square',   vol: 0.10 }),
    item:    () => { tone({ freq: 660, freq2: 990, dur: 0.10, type: 'triangle', vol: 0.14 }); setTimeout(() => tone({ freq: 990, freq2: 1320, dur: 0.10, type: 'triangle', vol: 0.14 }), 80) },
    boost:   () => { tone({ freq: 220, freq2: 880, dur: 0.30, type: 'sawtooth', vol: 0.14 }); noise({ dur: 0.25, vol: 0.05, hp: 900 }) },
    pad:     () => tone({ freq: 520,  freq2: 1100, dur: 0.10, type: 'triangle', vol: 0.10 }),
    missile: () => { tone({ freq: 90,  freq2: 220, dur: 0.40, type: 'sawtooth', vol: 0.17 }); noise({ dur: 0.35, vol: 0.08, hp: 400 }) },
    hit:     () => { tone({ freq: 180, freq2: 60,  dur: 0.18, type: 'square',   vol: 0.18 }); noise({ dur: 0.22, vol: 0.12, hp: 200 }) },
    jump:    () => tone({ freq: 300, freq2: 1200, dur: 0.18, type: 'triangle', vol: 0.16 }),
    land:    () => tone({ freq: 220, freq2: 110,  dur: 0.10, type: 'square',   vol: 0.12 }),
    finish:  () => { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => tone({ freq: f, dur: 0.18, type: 'triangle', vol: 0.18 }), i * 120)) },
    fall:    () => tone({ freq: 600, freq2: 80, dur: 0.6, type: 'sawtooth', vol: 0.16 }),
  }
})()
// Some browsers require a user gesture before audio plays
window.addEventListener('click', () => { try { new AudioContext() } catch(_) {} }, { once: true })

// ─── BGM (simple looped melody, gain controlled by profile) ─────────────────
const BGM = (() => {
  let ctx, masterGain, schedTimer
  const TEMPO = 120  // bpm
  // Cheery, bouncy 4-bar pattern in C major (MIDI numbers)
  const MELODY = [
    60, 64, 67, 64, 67, 72, 67, 64,
    62, 65, 69, 65, 69, 74, 69, 65,
    60, 64, 67, 64, 67, 72, 67, 64,
    65, 67, 69, 71, 72, 71, 69, 67,
  ]
  function note(t, midi, dur) {
    const f = 440 * Math.pow(2, (midi - 69) / 12)
    const osc = ctx.createOscillator()
    const g = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(f, t)
    g.gain.setValueAtTime(0.0001, t)
    g.gain.exponentialRampToValueAtTime(0.10, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.95)
    osc.connect(g); g.connect(masterGain)
    osc.start(t); osc.stop(t + dur)
  }
  let scheduled = 0
  function tick() {
    if (!ctx) return
    const now = ctx.currentTime
    const beat = 60 / TEMPO / 2  // eighth notes
    while (scheduled < now + 0.5) {
      const idx = Math.floor(scheduled / beat) % MELODY.length
      note(scheduled, MELODY[idx], beat)
      scheduled += beat
    }
    schedTimer = setTimeout(tick, 100)
  }
  return {
    start() {
      if (ctx) return
      ctx = new (window.AudioContext || window.webkitAudioContext)()
      masterGain = ctx.createGain()
      masterGain.gain.value = profile.settings.bgmVolume * 0.7
      masterGain.connect(ctx.destination)
      scheduled = ctx.currentTime + 0.1
      tick()
    },
    setVolume(v) { if (masterGain) masterGain.gain.value = v * 0.7 },
    stop() {
      if (schedTimer) clearTimeout(schedTimer)
      if (ctx) { ctx.close().catch(()=>{}); ctx = null }
      scheduled = 0
    },
  }
})()
// Start BGM on first user gesture
window.addEventListener('click', () => BGM.start(), { once: true })

// ─── Constants ───────────────────────────────────────────────────────────────
const TRACK_WIDTH   = 9
const TRACK_LENGTH  = 1000
const BALL_RADIUS   = 0.55
const PLAYER_SPEED  = 18
const BOOST_MULT    = 1.9
const BOOST_TIME    = 1.6
const LATERAL_SPEED = 7
const AI_COUNT      = 7
const COIN_COUNT    = 160
const PAD_COUNT     = 28
const OBST_COUNT    = 44
const FINISH_Z      = -(TRACK_LENGTH - 10)
const BOOST_FILL    = 5     // coins to fill manual weapon
const BARRIER_H     = 0.18  // very low rails — purely visual lane markers
const RAIL_GRACE    = 0.5   // how far past the floor edge a ball can perch before falling

// Narrow sections: [zStart, zEnd, widthScale]
const NARROW_ZONES = [
  [-110, -140, 0.55],
  [-230, -260, 0.50],
  [-360, -395, 0.45],
  [-510, -545, 0.55],
  [-650, -685, 0.50],
  [-800, -835, 0.45],
  [-920, -955, 0.50],
]
// One-sided zones: floor only exists on ONE half. Other half is empty air → ball falls.
// [zStart, zEnd, side ('L' = LEFT half is the open path, ball must go left)]
const ONE_SIDED_ZONES = [
  [-70,  -95,  'L'],
  [-200, -225, 'R'],
  [-310, -340, 'L'],
  [-440, -475, 'R'],
  [-580, -615, 'L'],
  [-720, -755, 'R'],
  [-870, -905, 'L'],
]
function activeWall(x, z) {
  for (const [a, b, side] of ONE_SIDED_ZONES) {
    if (z <= a && z >= b) {
      if (side === 'L' && x > 0) return 'R'   // right half is the void
      if (side === 'R' && x < 0) return 'L'   // left half is the void
    }
  }
  return null
}
// Center-void zones: the MIDDLE of the track is empty; ball must hug a side edge.
// [zStart, zEnd, gapFraction] — gapFraction of the width (centered) is empty air.
const CENTER_VOID_ZONES = [
  [-150, -180, 0.42],
  [-400, -435, 0.46],
  [-690, -715, 0.46],
  [-958, -980, 0.40],
]
function inCenterVoid(x, z) {
  for (const [a, b, gap] of CENTER_VOID_ZONES) {
    if (z <= a && z >= b) {
      if (Math.abs(x) < widthAt(z) * gap / 2) return true
    }
  }
  return false
}
function centerVoidAt(z) {
  for (const cz of CENTER_VOID_ZONES) if (z <= cz[0] && z >= cz[1]) return cz
  return null
}
function widthAt(z) {
  for (const [a, b, s] of NARROW_ZONES) {
    if (z <= a && z >= b) {
      const t = (a - z) / (a - b)         // 0..1 within zone
      const k = Math.sin(t * Math.PI)     // ease in/out
      return TRACK_WIDTH * (1 - (1 - s) * k)
    }
  }
  return TRACK_WIDTH
}

// ─── Game state ──────────────────────────────────────────────────────────────
let state          = 'MENU'    // 'MENU' | 'RACING' | 'CINEMATIC' | 'FINISHED'
let coinsCollected = 0
let finishedCount  = 0
let boostCharge    = 0          // 0..BOOST_FILL
let playerWeapon   = null       // null | 'speed' | 'missile'
let cineStart      = 0          // clock.elapsedTime when cinematic began
let firstFinishT   = 0          // clock.elapsedTime when 1st place crossed
const COUNTDOWN_S  = 15
const CINEMATIC_S  = 16

// Active missiles (player-fired)
const missiles = []

// ─── Renderer / Scene / Camera ───────────────────────────────────────────────
const canvas   = document.getElementById('canvas')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
renderer.shadowMap.enabled = !!profile.settings.shadows
renderer.shadowMap.type    = THREE.PCFSoftShadowMap

const scene  = new THREE.Scene()
scene.background = new THREE.Color(0x87ceeb)
scene.fog = new THREE.Fog(0x87ceeb, 70, 200)

const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 300)

function resize() {
  const w = window.innerWidth, h = window.innerHeight
  renderer.setSize(w, h)
  camera.aspect = w / h
  camera.updateProjectionMatrix()
}
resize()
window.addEventListener('resize', resize)

// ─── Lighting ────────────────────────────────────────────────────────────────
scene.add(new THREE.AmbientLight(0xffffff, 0.65))
const sun = new THREE.DirectionalLight(0xfff8e1, 1.4)
sun.position.set(20, 40, 20)
sun.castShadow = true
sun.shadow.camera.far = 300
sun.shadow.camera.left = sun.shadow.camera.bottom = -50
sun.shadow.camera.right = sun.shadow.camera.top   = 50
sun.shadow.mapSize.set(2048, 2048)
scene.add(sun)

// ─── Track ───────────────────────────────────────────────────────────────────
;(function buildTrack() {
  const floorMat = new THREE.MeshLambertMaterial({ color: 0xe8c97a, side: THREE.DoubleSide })
  // Build a strip mesh between z1 and z2 (z1 > z2). boundsFn(z) → {xL, xR}.
  function addStrip(z1, z2, boundsFn) {
    if (z1 <= z2) return
    const SLICE = 2
    const zList = []
    for (let z = z1; z > z2 + SLICE * 0.5; z -= SLICE) zList.push(z)
    zList.push(z2)
    const positions = []
    for (const z of zList) {
      const { xL, xR } = boundsFn(z)
      positions.push(xL, 0, z, xR, 0, z)
    }
    const indices = []
    for (let i = 0; i < zList.length - 1; i++) {
      const a = i*2, b = i*2+1, c = (i+1)*2, d = (i+1)*2+1
      indices.push(a, b, c, b, d, c)   // CCW → normals point +Y
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geo.setIndex(indices)
    geo.computeVertexNormals()
    const m = new THREE.Mesh(geo, floorMat)
    m.receiveShadow = true
    scene.add(m)
  }
  // Bound helpers
  const fullB  = z => { const w = widthAt(z) / 2; return { xL: -w, xR: w } }
  const leftB  = z => ({ xL: -widthAt(z) / 2, xR: 0 })
  const rightB = z => ({ xL: 0, xR: widthAt(z) / 2 })
  const leftEdgeB  = gap => z => ({ xL: -widthAt(z) / 2, xR: -widthAt(z) * gap / 2 })
  const rightEdgeB = gap => z => ({ xL:  widthAt(z) * gap / 2, xR: widthAt(z) / 2 })

  // Merge one-sided + center-void zones into a sorted segment list
  const special = [
    ...ONE_SIDED_ZONES.map(([a, b, side]) => ({ a, b, kind: 'oneside', side })),
    ...CENTER_VOID_ZONES.map(([a, b, gap]) => ({ a, b, kind: 'center', gap })),
  ].sort((x, y) => y.a - x.a)

  let cursorZ = 0
  for (const seg of special) {
    if (seg.a < cursorZ) addStrip(cursorZ, seg.a, fullB)
    if (seg.kind === 'oneside') {
      addStrip(seg.a, seg.b, seg.side === 'L' ? leftB : rightB)
    } else {   // center void → two edge strips, empty middle
      addStrip(seg.a, seg.b, leftEdgeB(seg.gap))
      addStrip(seg.a, seg.b, rightEdgeB(seg.gap))
    }
    cursorZ = seg.b
  }
  addStrip(cursorZ, -TRACK_LENGTH, fullB)

  // (Lane dividers omitted — they would clip through narrow/one-sided sections)

  const stripeD = 1.5
  const nStripes = Math.ceil(TRACK_LENGTH / stripeD)
  const mats = [
    new THREE.MeshLambertMaterial({ color: 0xffe234 }),
    new THREE.MeshLambertMaterial({ color: 0x222222 }),
  ]
  const bGeo = new THREE.BoxGeometry(0.55, BARRIER_H, stripeD - 0.06)
  for (const sideSign of [-1, 1]) {
    for (let i = 0; i < nStripes; i++) {
      const z = -i * stripeD - stripeD / 2
      // Skip outer barriers on the "void" side during one-sided zones
      let inVoidZone = false
      for (const [za, zb, openSide] of ONE_SIDED_ZONES) {
        if (z <= za && z >= zb) {
          const openSign = openSide === 'L' ? -1 : 1
          if (sideSign !== openSign) inVoidZone = true
        }
      }
      if (inVoidZone) continue
      // In one-sided zones, also add an inner-edge barrier along the centerline
      // so the open half has a guard on both sides
      const w = widthAt(z)
      const x = sideSign * (w / 2 + 0.3)
      const mesh = new THREE.Mesh(bGeo, mats[i % 2])
      mesh.position.set(x, BARRIER_H / 2, z)
      mesh.castShadow = true
      scene.add(mesh)
    }
  }
  // Inner edge barrier marking the drop-off (centerline) inside one-sided zones
  for (const [a, b, openSide] of ONE_SIDED_ZONES) {
    const len = a - b
    const innerX = openSide === 'L' ? -0.15 : 0.15
    const edge = new THREE.Mesh(
      new THREE.BoxGeometry(0.18, BARRIER_H * 1.2, len - 0.1),
      new THREE.MeshLambertMaterial({ color: 0xffe234 })
    )
    edge.position.set(innerX, BARRIER_H * 0.6, (a + b) / 2)
    scene.add(edge)
  }
  // Twin edge barriers at the gap of center-void zones (both sides of the hole)
  for (const [a, b, gap] of CENTER_VOID_ZONES) {
    const len = a - b
    const gapHalf = (TRACK_WIDTH * gap) / 2
    for (const side of [-1, 1]) {
      const edge = new THREE.Mesh(
        new THREE.BoxGeometry(0.18, BARRIER_H * 1.2, len - 0.1),
        new THREE.MeshLambertMaterial({ color: 0xffe234 })
      )
      edge.position.set(side * (gapHalf + 0.1), BARRIER_H * 0.6, (a + b) / 2)
      scene.add(edge)
    }
  }
  // (Narrow zones are baked into the floor strip via widthAt — no overlay needed)

  // Finish line (checkered)
  const cS = 0.5, cCols = Math.floor(TRACK_WIDTH / cS), cRows = 4
  const whiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff })
  const blackMat = new THREE.MeshLambertMaterial({ color: 0x111111 })
  const cGeo = new THREE.PlaneGeometry(cS, cS)
  for (let r = 0; r < cRows; r++) {
    for (let c = 0; c < cCols; c++) {
      const mat = (r + c) % 2 === 0 ? whiteMat : blackMat
      const m = new THREE.Mesh(cGeo, mat)
      m.rotation.x = -Math.PI / 2
      m.position.set(
        -TRACK_WIDTH / 2 + c * cS + cS / 2,
        0.02,
        FINISH_Z - cRows * cS / 2 + r * cS + cS / 2
      )
      scene.add(m)
    }
  }
})()

// ─── Speed boost pads (green tiles) ──────────────────────────────────────────
const padMeshes = []
const padData   = []
;(function spawnPads() {
  const geo = new THREE.PlaneGeometry(TRACK_WIDTH / 3 - 0.3, 3.5)
  const START_OFFSET = 75   // keep the first stretch clean so nobody boosts off the line
  const spacing = (TRACK_LENGTH - START_OFFSET - 20) / PAD_COUNT
  for (let i = 0; i < PAD_COUNT; i++) {
    const z = -START_OFFSET - i * spacing
    const lane = Math.floor(Math.random() * 3) - 1   // -1, 0, 1
    const x = lane * (TRACK_WIDTH / 3)
    const mat = new THREE.MeshPhongMaterial({
      color: 0x33ff77, emissive: 0x118833, shininess: 80,
      transparent: true, opacity: 0.92,
    })
    const m = new THREE.Mesh(geo, mat)
    m.rotation.x = -Math.PI / 2
    m.position.set(x, 0.03, z)
    scene.add(m)

    // Chevron arrow on the pad (apex points toward -Z, i.e. forward)
    const arrowGeo = new THREE.ShapeGeometry((() => {
      const s = new THREE.Shape()
      s.moveTo(0, 0.8); s.lineTo(-0.6, -0.2); s.lineTo(-0.25, -0.2)
      s.lineTo(-0.25, -0.8); s.lineTo(0.25, -0.8); s.lineTo(0.25, -0.2)
      s.lineTo(0.6, -0.2); s.closePath()
      return s
    })())
    const arrow = new THREE.Mesh(arrowGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }))
    arrow.rotation.x = -Math.PI / 2  // lay flat, apex (+y in shape) → -z in world
    arrow.position.set(x, 0.05, z)
    scene.add(arrow)

    padMeshes.push(m)
    padData.push({ x, z, halfW: (TRACK_WIDTH / 3 - 0.3) / 2, halfL: 1.75, mat, used: false })
  }
})()

// ─── Jump ramps (blue wedge ramps with real slope) ───────────────────────────
const jumpMeshes = []
const jumpData   = []
;(function spawnJumpRamps() {
  // Ramp position is the CENTER z of the ramp; we extend ±RAMP_HALF in z
  // Placed in clear gaps between narrow / one-sided / center-void zones
  const JUMP_CENTERS = [-65, -190, -285, -350, -492, -562, -777, -852]
  const RAMP_HALF   = 2.4    // ramp length 4.8
  const RAMP_PEAK   = 1.6    // height at the top edge
  const RAMP_HALF_W = TRACK_WIDTH * 0.22
  const rampMat = new THREE.MeshPhongMaterial({
    color: 0x4fc3ff, emissive: 0x224488, shininess: 80,
  })
  for (const z of JUMP_CENTERS) {
    const x = (Math.random() - 0.5) * TRACK_WIDTH * 0.3
    const xL = x - RAMP_HALF_W, xR = x + RAMP_HALF_W
    const zBack = z + RAMP_HALF, zFront = z - RAMP_HALF

    // Wedge: floor-level back edge, peak-height front edge
    const positions = new Float32Array([
      xL, 0, zBack,      // 0 A
      xR, 0, zBack,      // 1 B
      xL, 0, zFront,     // 2 C
      xR, 0, zFront,     // 3 D
      xL, RAMP_PEAK, zFront,  // 4 E
      xR, RAMP_PEAK, zFront,  // 5 F
    ])
    const indices = [
      // Ramp top surface (slope) - normal points up & forward
      0, 1, 5,   0, 5, 4,
      // Front vertical wall at zFront (the drop side, normal toward -z)
      3, 2, 4,   3, 4, 5,
      // Left side (triangle), normal toward -x
      0, 4, 2,
      // Right side (triangle), normal toward +x
      1, 3, 5,
    ]
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geo.setIndex(indices)
    geo.computeVertexNormals()
    const m = new THREE.Mesh(geo, rampMat)
    m.castShadow = true; m.receiveShadow = true
    scene.add(m)

    // White ↑ arrow decal placed on the slope surface
    const slopeAngle = Math.atan2(RAMP_PEAK, 2 * RAMP_HALF)
    const arrow = new THREE.Mesh(
      new THREE.ShapeGeometry((() => {
        const s = new THREE.Shape()
        s.moveTo(0, 1.0); s.lineTo(-0.7, 0.1); s.lineTo(-0.28, 0.1)
        s.lineTo(-0.28, -0.9); s.lineTo(0.28, -0.9); s.lineTo(0.28, 0.1)
        s.lineTo(0.7, 0.1); s.closePath()
        return s
      })()),
      new THREE.MeshBasicMaterial({ color: 0xffffff })
    )
    arrow.position.set(x, RAMP_PEAK * 0.5 + 0.02, z)
    arrow.rotation.x = -Math.PI / 2 + slopeAngle   // lay on slope
    scene.add(arrow)

    jumpMeshes.push(m)
    jumpData.push({
      x, z, halfW: RAMP_HALF_W, halfL: RAMP_HALF,
      zBack, zFront, peakY: RAMP_PEAK,
      slope: RAMP_PEAK / (zBack - zFront),
    })
  }
})()
// Surface height at a given (x, z) if on any ramp; returns -1 if not on any
function rampSurfaceY(x, z) {
  for (const j of jumpData) {
    if (Math.abs(x - j.x) < j.halfW && z <= j.zBack && z >= j.zFront) {
      // y increases as ball moves forward (z decreases) along slope
      return j.peakY * (j.zBack - z) / (j.zBack - j.zFront)
    }
  }
  return -1
}
function rampAt(x, z) {
  for (const j of jumpData) {
    if (Math.abs(x - j.x) < j.halfW && z <= j.zBack && z >= j.zFront) return j
  }
  return null
}

// ─── Item boxes (Mario-Kart style "?" boxes) ─────────────────────────────────
const itemMeshes = []
const itemData   = []
;(function spawnItemBoxes() {
  // Texture: yellow face with a "?" — one canvas reused on all faces
  const tex = (() => {
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const ctx = c.getContext('2d')
    const grad = ctx.createLinearGradient(0, 0, 0, 128)
    grad.addColorStop(0, '#ffe066'); grad.addColorStop(1, '#ffaa11')
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 128, 128)
    ctx.strokeStyle = '#7a4400'; ctx.lineWidth = 8
    ctx.strokeRect(4, 4, 120, 120)
    ctx.fillStyle = '#7a4400'
    ctx.font = 'bold 96px Arial Rounded MT Bold, Arial'
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    ctx.fillText('?', 64, 70)
    return new THREE.CanvasTexture(c)
  })()
  const geo = new THREE.BoxGeometry(0.95, 0.95, 0.95)
  const mat = new THREE.MeshPhongMaterial({ map: tex, emissive: 0x442200, shininess: 60 })
  const ITEM_START = 60   // first ? box starts further out so no instant weapon
  const spacing = (TRACK_LENGTH - ITEM_START - 20) / OBST_COUNT
  for (let i = 0; i < OBST_COUNT; i++) {
    const z = -ITEM_START - i * spacing - Math.random() * spacing * 0.4
    const x = (Math.random() - 0.5) * (TRACK_WIDTH - 1.8)
    const m = new THREE.Mesh(geo, mat.clone())
    m.position.set(x, 0.6, z)
    m.castShadow = true
    scene.add(m)
    itemMeshes.push(m)
    itemData.push({ x, z, r: 0.7, taken: false, respawn: 0 })
  }
})()

// ─── Skin catalog (also used as AI palettes) ─────────────────────────────────
const SKIN_CATALOG = [
  { id: 'classic',  name: 'Classic',   base: 0x3355cc, ring: 0xeeee11, price: 0    },
  { id: 'crimson',  name: 'Crimson',   base: 0xcc3333, ring: 0xffffff, price: 0    },
  { id: 'forest',   name: 'Forest',    base: 0x22aa44, ring: 0x113311, price: 0    },
  { id: 'ember',    name: 'Ember',     base: 0xcc6622, ring: 0xffeedd, price: 0    },
  { id: 'amethyst', name: 'Amethyst',  base: 0x8833cc, ring: 0xddaaff, price: 0    },
  { id: 'frost',    name: 'Frost',     base: 0x22aacc, ring: 0xffffff, price: 0    },
  { id: 'midnight', name: 'Midnight',  base: 0x111122, ring: 0xaa66ff, price: 50   },
  { id: 'gold',     name: 'Gold',      base: 0xffcc11, ring: 0xff6622, price: 100  },
  { id: 'lava',     name: 'Lava',      base: 0xff2200, ring: 0xffaa00, price: 80   },
  { id: 'ice',      name: 'Ice',       base: 0xaaeeff, ring: 0x3399cc, price: 80   },
  { id: 'jungle',   name: 'Jungle',    base: 0x117733, ring: 0xffe66e, price: 60   },
  { id: 'cosmic',   name: 'Cosmic',    base: 0x6622aa, ring: 0x00ffcc, price: 150  },
  { id: 'rose',     name: 'Rose',      base: 0xff88aa, ring: 0xffffff, price: 60   },
  { id: 'mint',     name: 'Mint',      base: 0x88ffcc, ring: 0x226644, price: 50   },
  { id: 'shadow',   name: 'Shadow',    base: 0x222222, ring: 0xff3344, price: 120  },
  { id: 'rainbow',  name: 'Rainbow',   base: 0xff66bb, ring: 0x66ffee, price: 200  },
  // National flag marbles
  { id: 'flag-in', name: 'India',       flag: 'in', price: 0   },
  { id: 'flag-vn', name: 'Vietnam',     flag: 'vn', price: 0   },
  { id: 'flag-kr', name: 'Korea',       flag: 'kr', price: 0   },
  { id: 'flag-jp', name: 'Japan',       flag: 'jp', price: 0   },
  { id: 'flag-us', name: 'USA',         flag: 'us', price: 40  },
  { id: 'flag-fr', name: 'France',      flag: 'fr', price: 40  },
  { id: 'flag-de', name: 'Germany',     flag: 'de', price: 40  },
  { id: 'flag-it', name: 'Italy',       flag: 'it', price: 40  },
  { id: 'flag-es', name: 'Spain',       flag: 'es', price: 40  },
  { id: 'flag-nl', name: 'Netherlands', flag: 'nl', price: 40  },
  { id: 'flag-se', name: 'Sweden',      flag: 'se', price: 40  },
  { id: 'flag-br', name: 'Brazil',      flag: 'br', price: 60  },
  { id: 'flag-gb', name: 'UK',          flag: 'gb', price: 60  },
  { id: 'flag-ca', name: 'Canada',      flag: 'ca', price: 60  },
]
// ─── Flags (canvas-drawn national marbles) ──────────────────────────────────
const FLAGS = {
  kr: { name: 'Korea',  tint: 0x003478, draw(c,w,h){
    c.fillStyle='#fff'; c.fillRect(0,0,w,h)
    const cx=w/2,cy=h/2,r=h*0.2
    c.save(); c.translate(cx,cy); c.rotate(-Math.PI/6)
    c.fillStyle='#c60c30'; c.beginPath(); c.arc(0,0,r,0,Math.PI*2); c.fill()
    c.fillStyle='#003478'; c.beginPath(); c.arc(0,0,r,0,Math.PI); c.fill()
    c.fillStyle='#c60c30'; c.beginPath(); c.arc(-r/2,0,r/2,0,Math.PI*2); c.fill()
    c.fillStyle='#003478'; c.beginPath(); c.arc(r/2,0,r/2,0,Math.PI*2); c.fill()
    c.restore()
  }},
  jp: { name: 'Japan',  tint: 0xbc002d, draw(c,w,h){
    c.fillStyle='#fff'; c.fillRect(0,0,w,h)
    c.fillStyle='#bc002d'; c.beginPath(); c.arc(w/2,h/2,h*0.28,0,Math.PI*2); c.fill()
  }},
  us: { name: 'USA',    tint: 0x3c3b6e, draw(c,w,h){
    const sh=h/13
    for(let i=0;i<13;i++){ c.fillStyle=i%2?'#fff':'#b22234'; c.fillRect(0,i*sh,w,sh) }
    c.fillStyle='#3c3b6e'; c.fillRect(0,0,w*0.42,sh*7)
    c.fillStyle='#fff'
    for(let r=0;r<5;r++)for(let col=0;col<6;col++){
      c.beginPath(); c.arc(w*0.05+col*w*0.064, sh*0.8+r*sh*1.3, 1.6,0,Math.PI*2); c.fill()
    }
  }},
  fr: { name: 'France', tint: 0x0055a4, draw(c,w,h){
    c.fillStyle='#0055a4'; c.fillRect(0,0,w/3,h)
    c.fillStyle='#fff';    c.fillRect(w/3,0,w/3,h)
    c.fillStyle='#ef4135'; c.fillRect(2*w/3,0,w/3,h)
  }},
  de: { name: 'Germany', tint: 0xdd0000, draw(c,w,h){
    c.fillStyle='#000';    c.fillRect(0,0,w,h/3)
    c.fillStyle='#dd0000'; c.fillRect(0,h/3,w,h/3)
    c.fillStyle='#ffce00'; c.fillRect(0,2*h/3,w,h/3)
  }},
  it: { name: 'Italy',   tint: 0x009246, draw(c,w,h){
    c.fillStyle='#009246'; c.fillRect(0,0,w/3,h)
    c.fillStyle='#fff';    c.fillRect(w/3,0,w/3,h)
    c.fillStyle='#ce2b37'; c.fillRect(2*w/3,0,w/3,h)
  }},
  es: { name: 'Spain',   tint: 0xf1bf00, draw(c,w,h){
    c.fillStyle='#aa151b'; c.fillRect(0,0,w,h)
    c.fillStyle='#f1bf00'; c.fillRect(0,h*0.25,w,h*0.5)
  }},
  nl: { name: 'Netherlands', tint: 0x21468b, draw(c,w,h){
    c.fillStyle='#ae1c28'; c.fillRect(0,0,w,h/3)
    c.fillStyle='#fff';    c.fillRect(0,h/3,w,h/3)
    c.fillStyle='#21468b'; c.fillRect(0,2*h/3,w,h/3)
  }},
  se: { name: 'Sweden',  tint: 0x006aa7, draw(c,w,h){
    c.fillStyle='#006aa7'; c.fillRect(0,0,w,h)
    c.fillStyle='#fecc00'
    c.fillRect(w*0.3,0,h*0.18,h)
    c.fillRect(0,h*0.41,w,h*0.18)
  }},
  br: { name: 'Brazil',  tint: 0x009c3b, draw(c,w,h){
    c.fillStyle='#009c3b'; c.fillRect(0,0,w,h)
    c.fillStyle='#ffdf00'; c.beginPath(); c.moveTo(w/2,h*0.12); c.lineTo(w*0.86,h/2); c.lineTo(w/2,h*0.88); c.lineTo(w*0.14,h/2); c.closePath(); c.fill()
    c.fillStyle='#002776'; c.beginPath(); c.arc(w/2,h/2,h*0.2,0,Math.PI*2); c.fill()
  }},
  gb: { name: 'UK',      tint: 0x012169, draw(c,w,h){
    c.fillStyle='#012169'; c.fillRect(0,0,w,h)
    c.strokeStyle='#fff'; c.lineWidth=h*0.16
    c.beginPath(); c.moveTo(0,0); c.lineTo(w,h); c.moveTo(w,0); c.lineTo(0,h); c.stroke()
    c.fillStyle='#fff'; c.fillRect(0,h*0.4,w,h*0.2); c.fillRect(w*0.42,0,w*0.16,h)
    c.fillStyle='#c8102e'; c.fillRect(0,h*0.45,w,h*0.1); c.fillRect(w*0.45,0,w*0.1,h)
  }},
  ca: { name: 'Canada',  tint: 0xd80621, draw(c,w,h){
    c.fillStyle='#fff';    c.fillRect(0,0,w,h)
    c.fillStyle='#d80621'; c.fillRect(0,0,w*0.25,h); c.fillRect(w*0.75,0,w*0.25,h)
    c.beginPath(); c.arc(w/2,h/2,h*0.16,0,Math.PI*2); c.fill()
  }},
  in: { name: 'India',   tint: 0xff9933, draw(c,w,h){
    c.fillStyle='#ff9933'; c.fillRect(0,0,w,h/3)        // saffron
    c.fillStyle='#fff';    c.fillRect(0,h/3,w,h/3)      // white
    c.fillStyle='#138808'; c.fillRect(0,2*h/3,w,h/3)    // green
    // Ashoka chakra (navy wheel) in the centre
    const cx=w/2, cy=h/2, r=h*0.14
    c.strokeStyle='#000080'; c.lineWidth=2
    c.beginPath(); c.arc(cx,cy,r,0,Math.PI*2); c.stroke()
    c.fillStyle='#000080'; c.beginPath(); c.arc(cx,cy,r*0.15,0,Math.PI*2); c.fill()
    for(let i=0;i<24;i++){
      const a=(i/24)*Math.PI*2
      c.beginPath(); c.moveTo(cx,cy); c.lineTo(cx+Math.cos(a)*r, cy+Math.sin(a)*r); c.stroke()
    }
  }},
  vn: { name: 'Vietnam', tint: 0xda251d, draw(c,w,h){
    c.fillStyle='#da251d'; c.fillRect(0,0,w,h)          // red field
    // yellow 5-pointed star
    const cx=w/2, cy=h/2, R=h*0.3, r=R*0.42
    c.fillStyle='#ffff00'; c.beginPath()
    for(let i=0;i<10;i++){
      const rad=i%2===0?R:r
      const a=-Math.PI/2 + i*Math.PI/5
      const x=cx+Math.cos(a)*rad, y=cy+Math.sin(a)*rad
      i===0 ? c.moveTo(x,y) : c.lineTo(x,y)
    }
    c.closePath(); c.fill()
  }},
}
const _flagTexCache = {}
function makeFlagTexture(code) {
  if (_flagTexCache[code]) return _flagTexCache[code]
  const w = 256, h = 128
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h
  const ctx = cv.getContext('2d')
  ;(FLAGS[code] || FLAGS.kr).draw(ctx, w, h)
  const tex = new THREE.CanvasTexture(cv)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearFilter
  _flagTexCache[code] = tex
  return tex
}
const _flagURLCache = {}
function flagDataURL(code) {
  if (_flagURLCache[code]) return _flagURLCache[code]
  const w = 64, h = 64
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h
  ;(FLAGS[code] || FLAGS.kr).draw(cv.getContext('2d'), w, h)
  const url = cv.toDataURL()
  _flagURLCache[code] = url
  return url
}

// AI palettes used for the other 7 balls — picks the first 8 of catalog
const BALL_PALETTES = SKIN_CATALOG.slice(0, 8).map(s => ({ base: s.base, ring: s.ring }))

function getEquippedSkin() {
  return SKIN_CATALOG.find(s => s.id === profile.equippedSkin) || SKIN_CATALOG[0]
}
// Floating name tag sprite — used to disambiguate balls (esp. when skins match in multi)
function makeNameTag(text, accent = 0xffffff) {
  const canvas = document.createElement('canvas')
  canvas.width = 256; canvas.height = 64
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, 256, 64)
  // Pill background
  const r = 22
  ctx.fillStyle = 'rgba(0,0,0,0.7)'
  ctx.beginPath()
  ctx.moveTo(r, 4); ctx.lineTo(252 - r, 4)
  ctx.arcTo(252, 4, 252, 32, r); ctx.arcTo(252, 60, 252 - r, 60, r)
  ctx.lineTo(r, 60); ctx.arcTo(4, 60, 4, 32, r); ctx.arcTo(4, 4, r, 4, r)
  ctx.closePath(); ctx.fill()
  // Accent dot on the left
  ctx.fillStyle = '#' + accent.toString(16).padStart(6, '0')
  ctx.beginPath(); ctx.arc(28, 32, 12, 0, Math.PI * 2); ctx.fill()
  // Text
  ctx.fillStyle = '#fff'
  ctx.font = 'bold 28px "Arial Rounded MT Bold", Arial'
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'
  ctx.fillText(text, 52, 33, 190)
  const tex = new THREE.CanvasTexture(canvas)
  tex.minFilter = THREE.LinearFilter
  const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(2.6, 0.65, 1)        // world-space scale
  sprite.position.set(0, 1.6, 0)        // float above the ball
  sprite.renderOrder = 500
  return sprite
}

// Apply a skin (solid color OR flag texture) to an existing ball mesh
function applySkin(mesh, skin) {
  const mat = mesh.material
  const ringMesh = mesh.children.find(c => c.geometry?.type === 'TorusGeometry')
  if (skin.flag) {
    mat.map = makeFlagTexture(skin.flag)
    mat.color.setHex(0xffffff)
    mesh.userData.baseColor = (FLAGS[skin.flag]?.tint ?? 0xffffff)
    if (ringMesh) ringMesh.visible = false
  } else {
    mat.map = null
    mat.color.setHex(skin.base)
    mesh.userData.baseColor = skin.base
    if (ringMesh) { ringMesh.visible = true; ringMesh.material.color.setHex(skin.ring) }
  }
  mat.needsUpdate = true
}

function makeBall(idx, customSkin = null, label = null) {
  const palette = customSkin || BALL_PALETTES[idx % BALL_PALETTES.length]
  const { base, ring } = palette
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_RADIUS, 28, 20),
    new THREE.MeshPhongMaterial({ color: base ?? 0xffffff, shininess: 90, emissive: 0x000000 })
  )
  const ringMesh = new THREE.Mesh(
    new THREE.TorusGeometry(BALL_RADIUS * 1.01, BALL_RADIUS * 0.17, 8, 32),
    new THREE.MeshPhongMaterial({ color: ring ?? 0xffffff })
  )
  ringMesh.rotation.x = Math.PI / 2
  mesh.add(ringMesh)
  mesh.castShadow = true
  if (customSkin && customSkin.flag) applySkin(mesh, customSkin)

  // Boost halo (invisible by default)
  const halo = new THREE.Mesh(
    new THREE.SphereGeometry(BALL_RADIUS * 1.6, 20, 14),
    new THREE.MeshBasicMaterial({ color: 0xfffacc, transparent: true, opacity: 0 })
  )
  mesh.add(halo)
  mesh.userData.halo = halo
  mesh.userData.baseColor = base

  // Optional name tag floating above the ball
  if (label) {
    const tag = makeNameTag(label, ring)
    mesh.add(tag)
    mesh.userData.tag = tag
  }
  return mesh
}
function setBallLabel(ballMesh, text) {
  if (ballMesh.userData.tag) ballMesh.remove(ballMesh.userData.tag)
  if (!text) return
  const accent = ballMesh.children.find(c => c.geometry?.type === 'TorusGeometry')?.material?.color?.getHex() ?? 0xffffff
  const tag = makeNameTag(text, accent)
  ballMesh.add(tag)
  ballMesh.userData.tag = tag
}

// ─── Player ──────────────────────────────────────────────────────────────────
const player = { mesh: makeBall(0, getEquippedSkin()), x: 0, y: BALL_RADIUS, z: -2, vx: 0, vy: 0,
                 finished: false, order: 0, boost: 0, slow: 0,
                 respawn: 0, crane: null, fellOff: false }
player.mesh.position.set(0, BALL_RADIUS, -2)
scene.add(player.mesh)

// ─── AI balls ────────────────────────────────────────────────────────────────
const AI_Z_OFFSETS = [4, 3, 2, -2, -5, -8, -11]   // 7 AI balls (player starts ~4th)
const aiBalls = Array.from({ length: AI_COUNT }, (_, i) => {
  const b = {
    mesh:     makeBall(i + 1),
    x:        (i % 3 - 1) * 2.4,
    y:        BALL_RADIUS,
    z:        -2 + AI_Z_OFFSETS[i],
    speed:    PLAYER_SPEED * (0.88 + Math.random() * 0.14),
    phase:    Math.random() * Math.PI * 2,
    vx:       0,
    vy:       0,
    finished: false,
    order:    0,
    boost:    0,
    slow:     0,
    respawn:  0,
    crane:    null,
    fellOff:  false,
  }
  b.mesh.position.set(b.x, BALL_RADIUS, b.z)
  scene.add(b.mesh)
  return b
})

// ─── Coins ───────────────────────────────────────────────────────────────────
const coinMeshes = []
const coinData   = []
;(function spawnCoins() {
  const geo = new THREE.CylinderGeometry(0.32, 0.32, 0.13, 18)
  const mat = new THREE.MeshPhongMaterial({ color: 0xffe234, shininess: 120, emissive: 0x443300 })
  const spacing = (TRACK_LENGTH - 20) / COIN_COUNT
  for (let i = 0; i < COIN_COUNT; i++) {
    const z = -10 - i * spacing - Math.random() * spacing * 0.5
    const x = (Math.random() - 0.5) * (TRACK_WIDTH - 2)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(x, 0.7, z)
    mesh.castShadow = true
    scene.add(mesh)
    coinMeshes.push(mesh)
    coinData.push({ x, z, collected: false })
  }
})()

// ─── Speed lines plane (Kart-Rider style radial converge) ───────────────────
const speedLines = (() => {
  const SZ = 1024
  const tex = (() => {
    const c = document.createElement('canvas')
    c.width = c.height = SZ
    const ctx = c.getContext('2d')
    ctx.clearRect(0, 0, SZ, SZ)
    const cx = SZ / 2, cy = SZ / 2
    // Radial gradient: dark center punch-out → bright outer ring → fade
    // Lines emanate outward (so they appear to converge into the center when
    // we animate inwards or simply when the player moves forward)
    const N = 120
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * Math.PI * 2 + Math.random() * 0.04
      const innerR = 100 + Math.random() * 80   // start outside the dark hole
      const outerR = innerR + 200 + Math.random() * 260
      const lw = 6 + Math.random() * 14
      const grad = ctx.createLinearGradient(
        cx + Math.cos(ang) * innerR, cy + Math.sin(ang) * innerR,
        cx + Math.cos(ang) * outerR, cy + Math.sin(ang) * outerR
      )
      grad.addColorStop(0,    'rgba(255,255,255,0)')
      grad.addColorStop(0.35, 'rgba(255,255,255,0.95)')
      grad.addColorStop(1,    'rgba(255,255,255,0)')
      ctx.strokeStyle = grad; ctx.lineWidth = lw; ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(ang) * innerR, cy + Math.sin(ang) * innerR)
      ctx.lineTo(cx + Math.cos(ang) * outerR, cy + Math.sin(ang) * outerR)
      ctx.stroke()
    }
    // Soft alpha vignette so the very center is empty (focal point)
    const rg = ctx.createRadialGradient(cx, cy, 0, cx, cy, SZ / 2)
    rg.addColorStop(0,    'rgba(0,0,0,1)')
    rg.addColorStop(0.18, 'rgba(0,0,0,0)')
    rg.addColorStop(1,    'rgba(0,0,0,0)')
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = rg; ctx.fillRect(0, 0, SZ, SZ)
    ctx.globalCompositeOperation = 'source-over'
    return new THREE.CanvasTexture(c)
  })()
  const mat = new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0,
    depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
  })
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(50, 30), mat)
  mesh.renderOrder = 999
  camera.add(mesh)
  mesh.position.set(0, 0, -10)
  mesh.userData.tex = tex
  scene.add(camera)
  return mesh
})()

// ─── Input ───────────────────────────────────────────────────────────────────
const keys = { left: false, right: false }
window.addEventListener('keydown', e => {
  if (e.code === 'KeyA'    || e.code === 'ArrowLeft')  keys.left  = true
  if (e.code === 'KeyD'    || e.code === 'ArrowRight') keys.right = true
  if (e.code === 'Space') {
    if (state === 'MENU') startGame()
    else if (state === 'RACING' && playerWeapon && !player.finished) {
      useWeapon()
    }
  }
})
window.addEventListener('keyup', e => {
  if (e.code === 'KeyA'    || e.code === 'ArrowLeft')  keys.left  = false
  if (e.code === 'KeyD'    || e.code === 'ArrowRight') keys.right = false
})

let touchStartX = null
canvas.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX }, { passive: true })
canvas.addEventListener('touchmove', e => {
  if (touchStartX === null) return
  const dx = e.touches[0].clientX - touchStartX
  keys.left  = dx < -15
  keys.right = dx > 15
}, { passive: true })
canvas.addEventListener('touchend', () => { keys.left = keys.right = false; touchStartX = null })

// On-screen touch buttons (mobile)
function wireTouchPad(id, dir) {
  const el = document.getElementById(id)
  if (!el) return
  const press   = e => { e.preventDefault(); keys[dir] = true  }
  const release = e => { e.preventDefault(); keys[dir] = false }
  el.addEventListener('touchstart', press,   { passive: false })
  el.addEventListener('touchend',   release, { passive: false })
  el.addEventListener('touchcancel',release, { passive: false })
  el.addEventListener('mousedown',  press)
  el.addEventListener('mouseup',    release)
  el.addEventListener('mouseleave', release)
}
wireTouchPad('touch-left',  'left')
wireTouchPad('touch-right', 'right')

// ─── UI ──────────────────────────────────────────────────────────────────────
const $racing   = document.getElementById('racing-ui')
const $finish   = document.getElementById('finish-screen')
const $rankTxt  = document.getElementById('rank-text')
const $coinTxt  = document.getElementById('coin-count')
const $progFill = document.getElementById('progress-fill')
const $progBg   = document.getElementById('progress-bg')

// Screen router
const SCREENS = ['menu', 'single', 'multi', 'shop', 'settings']
function showScreen(name) {
  SCREENS.forEach(s => {
    document.getElementById(`${s}-screen`).classList.toggle('show', s === name)
  })
  $racing.classList.remove('show')
  $finish.classList.remove('show')
  refreshCoinDisplays()
}
function refreshCoinDisplays() {
  document.querySelectorAll('#menu-coins, .shop-coins').forEach(el => el.textContent = profile.coins.toLocaleString())
  const best = profile.bestRanks.length ? Math.min(...profile.bestRanks) : null
  const $best = document.getElementById('menu-best')
  if ($best) $best.textContent = best ? ordinalShort(best) : '—'
  const $races = document.getElementById('menu-races')
  if ($races) $races.textContent = profile.bestRanks.length
  // Equipped skin preview
  const sk = getEquippedSkin()
  const $mini = document.getElementById('menu-skin-mini')
  if ($mini) {
    const ring = $mini.querySelector('.skin-mini-ring')
    if (sk.flag) {
      $mini.style.backgroundImage = `url(${flagDataURL(sk.flag)})`
      $mini.style.backgroundSize = 'cover'
      $mini.style.backgroundPosition = 'center'
      $mini.style.background = $mini.style.background  // keep image
      if (ring) ring.style.display = 'none'
    } else {
      $mini.style.backgroundImage = 'none'
      $mini.style.background = '#' + sk.base.toString(16).padStart(6, '0')
      if (ring) { ring.style.display = ''; ring.style.background = '#' + sk.ring.toString(16).padStart(6, '0') }
    }
  }
  const $skName = document.getElementById('menu-skin-name')
  if ($skName) $skName.textContent = sk.name
}
function ordinalShort(n) {
  const s = ['th','st','nd','rd'], v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
// Wire all data-go="X" buttons → showScreen(X)
document.querySelectorAll('[data-go]').forEach(b => {
  b.addEventListener('click', () => showScreen(b.dataset.go))
})

// Inject boost button + ball markers into existing HUD
const $boostBtn = document.createElement('div')
$boostBtn.id = 'boost-btn'
$boostBtn.innerHTML = '<span id="boost-icon">⚡</span><small id="boost-sub">SPACE</small>'
$racing.appendChild($boostBtn)

const styleEl = document.createElement('style')
styleEl.textContent = `
  #boost-btn {
    position: absolute; right: 24px; bottom: 60px;
    width: 76px; height: 76px; border-radius: 50%;
    background: rgba(40,40,40,0.55); color: #fff;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    font-weight: bold; pointer-events: all; cursor: pointer;
    border: 3px solid rgba(255,255,255,0.3); opacity: 0.5;
    transition: transform 0.15s, opacity 0.2s, background 0.2s, border-color 0.2s;
  }
  #boost-btn span { font-size: 28px; line-height: 1; }
  #boost-btn small { font-size: 10px; letter-spacing: 1px; margin-top: 3px; opacity: 0.8; }
  #boost-btn.ready { background: linear-gradient(180deg,#ffcc33,#ff8822);
                     border-color: #fff; opacity: 1; box-shadow: 0 0 18px rgba(255,180,40,0.7); }
  #boost-btn.ready.missile { background: linear-gradient(180deg,#ff5544,#aa1111);
                             box-shadow: 0 0 18px rgba(255,80,60,0.7); }
  #boost-btn.ready:active { transform: scale(0.92); }
  .ball-marker {
    position: absolute; top: -7px; width: 14px; height: 14px; border-radius: 50%;
    transform: translateX(-50%); border: 2px solid rgba(255,255,255,0.9); transition: left 0.2s;
  }
  .ball-marker.player { width: 18px; height: 18px; top: -9px; border-color: #ffe44d; z-index: 2; }
`
document.head.appendChild(styleEl)
$boostBtn.addEventListener('click', () => {
  if (state === 'RACING' && playerWeapon && !player.finished) useWeapon()
})

function useWeapon() {
  if (playerWeapon === 'speed') {
    player.boost = Math.max(player.boost, BOOST_TIME)
    SFX.boost()
  } else if (playerWeapon === 'missile') {
    fireMissile(player)
    SFX.missile()
  }
  playerWeapon = null
  boostCharge = 0
  updateWeaponUI()
}

function fireMissile(owner) {
  const geo = new THREE.ConeGeometry(0.35, 1.4, 12)
  const mat = new THREE.MeshPhongMaterial({ color: 0xff3322, emissive: 0x661100 })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.rotation.x = -Math.PI / 2   // point forward (-z)
  mesh.position.set(owner.x, BALL_RADIUS, owner.z - 1.2)
  scene.add(mesh)
  // Trail (small glowing sphere)
  const trail = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 12, 10),
    new THREE.MeshBasicMaterial({ color: 0xffcc44, transparent: true, opacity: 0.6 })
  )
  trail.position.copy(mesh.position)
  scene.add(trail)
  missiles.push({ mesh, trail, x: owner.x, z: owner.z - 1.2, speed: 48, life: 6, owner })
}

// Ball markers on progress bar
const allBalls = [player, ...aiBalls]
const markerEls = allBalls.map((b, i) => {
  const el = document.createElement('div')
  el.className = 'ball-marker' + (i === 0 ? ' player' : '')
  const pal = BALL_PALETTES[i]
  el.style.background = '#' + pal.base.toString(16).padStart(6, '0')
  $progBg.appendChild(el)
  return el
})

function updateWeaponUI() {
  const $icon = document.getElementById('boost-icon')
  const $sub  = document.getElementById('boost-sub')
  if (playerWeapon === 'speed') {
    $boostBtn.classList.add('ready'); $boostBtn.classList.remove('missile')
    $icon.textContent = '⚡'; $sub.textContent = 'BOOST'
  } else if (playerWeapon === 'missile') {
    $boostBtn.classList.add('ready'); $boostBtn.classList.add('missile')
    $icon.textContent = '🚀'; $sub.textContent = 'FIRE'
  } else {
    $boostBtn.classList.remove('ready'); $boostBtn.classList.remove('missile')
    $icon.textContent = '⚡'; $sub.textContent = `${boostCharge}/${BOOST_FILL}`
  }
}
const updateBoostUI = updateWeaponUI  // backwards-compat alias

function ordinal(n) {
  const s = ['th','st','nd','rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

// Display name for a ball (country flag name, or "You" for the player)
function ballName(o) {
  if (o === player) return 'You'
  const sk = o.skin
  if (sk && sk.flag) return FLAGS[sk.flag]?.name || 'CPU'
  const idx = aiBalls.indexOf(o)
  return `CPU ${idx + 1}`
}
let _hitToastTimer = null
function showHitToast(attacker, victim) {
  const el = document.getElementById('hit-toast')
  if (!el) return
  el.innerHTML = `💥 <b>${ballName(attacker)}</b> hit <b>${ballName(victim)}</b>!`
  el.classList.add('show')
  clearTimeout(_hitToastTimer)
  _hitToastTimer = setTimeout(() => el.classList.remove('show'), 2200)
}

function getLiveRank() {
  let ahead = 0
  // A ball is "ahead" if it already finished OR is further down the track
  aiBalls.forEach(b => { if (b.finished || b.z < player.z) ahead++ })
  return ahead + 1
}

function startGame() {
  state = 'RACING'
  coinsCollected = 0
  finishedCount  = 0
  cineStart      = 0
  firstFinishT   = 0
  document.getElementById('countdown').classList.remove('show', 'urgent')
  document.getElementById('hit-toast').classList.remove('show')
  boostCharge = 0; playerWeapon = null; updateWeaponUI()
  missiles.forEach(m => { scene.remove(m.mesh); scene.remove(m.trail) })
  missiles.length = 0

  // Hide all menus
  SCREENS.forEach(s => document.getElementById(`${s}-screen`).classList.remove('show'))
  $finish.classList.remove('show')
  $racing.classList.add('show')

  // Re-apply equipped skin to player ball + marker
  const sk = getEquippedSkin()
  applySkin(player.mesh, sk)
  player.skin = sk
  const playerMarkerColor = sk.flag ? (FLAGS[sk.flag]?.tint ?? 0xffffff) : sk.base
  if (markerEls[0]) markerEls[0].style.background = '#' + playerMarkerColor.toString(16).padStart(6, '0')

  // National competition: give every AI a random country flag (≠ player's)
  const playerFlag = sk.flag || null
  const aiFlagPool = Object.keys(FLAGS).filter(c => c !== playerFlag).sort(() => Math.random() - 0.5)
  aiBalls.forEach((b, i) => {
    const code = aiFlagPool[i % aiFlagPool.length]
    const aiSkin = { flag: code }
    applySkin(b.mesh, aiSkin)
    b.skin = aiSkin
    if (markerEls[i + 1]) markerEls[i + 1].style.background = '#' + (FLAGS[code]?.tint ?? 0xffffff).toString(16).padStart(6, '0')
  })


  player.x = 0; player.y = BALL_RADIUS; player.z = -2; player.vx = 0; player.vy = 0
  player.finished = false; player.order = 0
  player.boost = 0; player.slow = 0; player.respawn = 0; player.fellOff = false; player.dnf = false; player.coastV = 0
  if (player.crane) { scene.remove(player.crane); player.crane = null }
  player.lastSafeZ = -2
  player.mesh.position.set(0, BALL_RADIUS, -2)
  player.mesh.userData.halo.material.opacity = 0

  aiBalls.forEach((b, i) => {
    b.x = (i % 3 - 1) * 2.4
    b.y = BALL_RADIUS
    b.z = -2 + AI_Z_OFFSETS[i]
    b.lastSafeZ = b.z
    b.vx = 0; b.vy = 0
    b.finished = false; b.order = 0; b.boost = 0; b.slow = 0; b.respawn = 0; b.fellOff = false; b.dnf = false; b.coastV = 0
    if (b.crane) { scene.remove(b.crane); b.crane = null }
    b.mesh.position.set(b.x, BALL_RADIUS, b.z)
    b.speed = PLAYER_SPEED * (0.88 + Math.random() * 0.14)
    b.phase = Math.random() * Math.PI * 2
    b.mesh.userData.halo.material.opacity = 0
  })

  coinData.forEach((c, i) => { c.collected = false; coinMeshes[i].visible = true })
  padData.forEach((p, i) => {
    p.used = false
    padMeshes[i].visible = true
    padMeshes[i].material.opacity = 0.92
    padMeshes[i].material.color.setHex(0x33ff77)
  })
  itemData.forEach((o, i) => { o.taken = false; itemMeshes[i].visible = true })
  $coinTxt.textContent = '0'
}

function startCinematic() {
  state = 'CINEMATIC'
  cineStart = clock.elapsedTime
  $racing.classList.remove('show')
}
function recordFinish(o) {
  finishedCount++
  o.order = finishedCount
  if (finishedCount === 1) {
    firstFinishT = clock.elapsedTime
    document.getElementById('countdown').classList.add('show')
  }
}

function buildLeaderboard() {
  // Collect every ball (player + AI) and sort by order (1 = first to finish).
  // Anyone with order=0 still didn't reach the line → put them in the order they
  // are currently positioned (closer to FINISH_Z = better).
  const all = [
    { who: player, label: 'YOU', skin: player.skin || getEquippedSkin() },
    ...aiBalls.map((b, i) => ({ who: b, label: `CPU ${i + 1}`, skin: b.skin || BALL_PALETTES[i + 1] })),
  ]
  all.sort((x, y) => {
    const ox = x.who.order || 999, oy = y.who.order || 999
    if (ox !== oy) return ox - oy
    return x.who.z - y.who.z
  })
  const $lb = document.getElementById('leaderboard')
  $lb.innerHTML = ''
  all.forEach((row, i) => {
    const sk = row.skin
    const isYou = row.who === player
    const dnf  = !!row.who.dnf
    let ballHtml, nameLabel
    if (sk.flag) {
      ballHtml = `<span class="lb-ball" style="background-image:url(${flagDataURL(sk.flag)});
                       background-size:cover; background-position:center;"></span>`
      nameLabel = isYou ? `${FLAGS[sk.flag]?.name || row.label} ⭐` : (FLAGS[sk.flag]?.name || row.label)
    } else {
      const base = '#' + (sk.base ?? 0xffffff).toString(16).padStart(6, '0')
      const ring = '#' + (sk.ring ?? 0xffffff).toString(16).padStart(6, '0')
      ballHtml = `<span class="lb-ball" style="background:${base}">
                    <span class="lb-ring" style="background:${ring}"></span>
                  </span>`
      nameLabel = row.label + (isYou ? ' ⭐' : '')
    }
    const $row = document.createElement('div')
    $row.className = 'lb-row' + (isYou ? ' you' : '')
    $row.innerHTML = `
      <span class="lb-place">${ordinal(i + 1)}</span>
      ${ballHtml}
      <span class="lb-name">${nameLabel}</span>
      <span class="lb-status">${dnf ? 'DNF' : '✅'}</span>
    `
    $lb.appendChild($row)
  })
}

function showFinish() {
  state = 'FINISHED'
  document.getElementById('countdown').classList.remove('show', 'urgent')
  $finish.classList.add('show')
  // player.order is the true finishing position (finishers 1..N, then DNF stragglers)
  const myRank = player.order || (AI_COUNT + 1)
  const $title = document.getElementById('finish-title')
  const $coins = document.getElementById('finish-coins')

  // Rank-multiplier reward: coins picked × multiplier
  // 1st=1.8, 2nd=1.5, 3rd=1.4, 4th=1.3, 5th=1.2, 6th=1.1, 7th=1.05, 8th=1.0
  const RANK_MULT = [0, 1.8, 1.5, 1.4, 1.3, 1.2, 1.1, 1.05, 1.0]
  const mult   = RANK_MULT[myRank] || 1.0
  const earned = Math.floor(coinsCollected * mult)
  profile.coins += earned
  profile.bestRanks.unshift(myRank); profile.bestRanks = profile.bestRanks.slice(0, 20)
  saveProfile()

  if (myRank === 1)     { $title.textContent = '🏆 1st Place!';        $title.style.color = '#ffe44d' }
  else if (myRank <= 3) { $title.textContent = `🥈 ${ordinal(myRank)} Place`; $title.style.color = '#aaddff' }
  else                  { $title.textContent = `${ordinal(myRank)} Place`;    $title.style.color = '#ffffff' }
  $coins.innerHTML = `<span class="coin-icon"></span> ${coinsCollected} picked × <span style="color:#ffe44d">${mult.toFixed(2)}×</span> = <b>${earned} coins</b>`
  buildLeaderboard()
}

document.getElementById('start-btn').addEventListener('click', startGame)
document.getElementById('retry-btn').addEventListener('click', () => {
  $finish.classList.remove('show')
  startGame()
})
document.getElementById('finish-menu-btn').addEventListener('click', () => {
  $finish.classList.remove('show')
  state = 'MENU'
  showScreen('menu')
})
// Allow Esc to bail out of a race back to menu
window.addEventListener('keydown', e => {
  if (e.code === 'Escape' && (state === 'RACING' || state === 'CINEMATIC')) {
    state = 'MENU'
    $racing.classList.remove('show')
    $finish.classList.remove('show')
    showScreen('menu')
  }
})

// ─── Shop ────────────────────────────────────────────────────────────────────
function renderShop() {
  const $grid = document.getElementById('shop-grid')
  $grid.innerHTML = ''
  for (const sk of SKIN_CATALOG) {
    const owned    = profile.ownedSkins.includes(sk.id)
    const equipped = profile.equippedSkin === sk.id
    const card = document.createElement('div')
    card.className = 'shop-card' + (equipped ? ' equipped' : '') + (owned ? ' owned' : ' locked')
    let ballHtml
    if (sk.flag) {
      ballHtml = `<div class="shop-ball" style="background-image:url(${flagDataURL(sk.flag)});
                       background-size:cover; background-position:center;"></div>`
    } else {
      const base = '#' + sk.base.toString(16).padStart(6, '0')
      const ring = '#' + sk.ring.toString(16).padStart(6, '0')
      ballHtml = `<div class="shop-ball" style="background:${base}">
                    <span class="shop-ring" style="background:${ring}"></span>
                  </div>`
    }
    card.innerHTML = `
      ${ballHtml}
      <div class="shop-name">${sk.name}</div>
      <div class="shop-price">${equipped ? '✓ EQUIPPED' : owned ? 'OWNED' : '<span class="coin-icon"></span> ' + sk.price}</div>
    `
    card.addEventListener('click', () => onShopClick(sk))
    $grid.appendChild(card)
  }
  refreshCoinDisplays()
}
function onShopClick(sk) {
  if (profile.ownedSkins.includes(sk.id)) {
    profile.equippedSkin = sk.id
    saveProfile(); renderShop()
    SFX.item()
  } else if (profile.coins >= sk.price) {
    profile.coins -= sk.price
    profile.ownedSkins.push(sk.id)
    profile.equippedSkin = sk.id
    saveProfile(); renderShop()
    SFX.finish()
  } else {
    SFX.hit()   // can't afford
  }
}

// ─── Settings ────────────────────────────────────────────────────────────────
function initSettings() {
  const $sfx = document.getElementById('sfx-slider')
  const $bgm = document.getElementById('bgm-slider')
  const $sfxV = document.getElementById('sfx-value')
  const $bgmV = document.getElementById('bgm-value')
  $sfx.value = Math.round(profile.settings.sfxVolume * 100); $sfxV.textContent = $sfx.value
  $bgm.value = Math.round(profile.settings.bgmVolume * 100); $bgmV.textContent = $bgm.value
  $sfx.addEventListener('input', () => {
    profile.settings.sfxVolume = $sfx.value / 100
    $sfxV.textContent = $sfx.value; saveProfile()
  })
  $bgm.addEventListener('input', () => {
    profile.settings.bgmVolume = $bgm.value / 100
    $bgmV.textContent = $bgm.value; BGM.setVolume(profile.settings.bgmVolume); saveProfile()
  })

  function bindToggle(id, key, onChange) {
    const el = document.getElementById(id)
    el.classList.toggle('on', !!profile.settings[key])
    el.addEventListener('click', () => {
      profile.settings[key] = !profile.settings[key]
      el.classList.toggle('on', profile.settings[key])
      saveProfile(); onChange?.(profile.settings[key])
    })
  }
  bindToggle('shake-toggle', 'shake')
  bindToggle('shadows-toggle', 'shadows', v => {
    renderer.shadowMap.enabled = v
    scene.traverse(o => { if (o.isMesh) o.castShadow = v ? o.castShadow : false })
  })
  bindToggle('markers-toggle', 'markers', v => {
    markerEls.forEach(el => el.style.display = v ? '' : 'none')
  })

  document.getElementById('reset-data-btn').addEventListener('click', () => {
    if (!confirm('Reset all user data? This will erase coins, owned skins, and settings.')) return
    resetProfile()
    initSettings()
    renderShop()
    showScreen('menu')
  })
}

// ─── Multi lobby (local-only stub) ──────────────────────────────────────────
let currentRoom = null
function makeRoomCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''; for (let i = 0; i < 6; i++) s += A[Math.floor(Math.random() * A.length)]
  return s
}
function renderRoom() {
  const $slots = document.getElementById('player-slots')
  $slots.innerHTML = ''
  const slots = currentRoom.players  // array of 8: {kind:'you'|'ai'|'empty', name}
  slots.forEach((p, i) => {
    const div = document.createElement('div')
    div.className = 'player-slot ' + p.kind
    div.innerHTML = `<span style="opacity:0.7;">${i + 1}.</span> ${p.kind === 'empty' ? '— waiting —' : p.name}${p.kind === 'you' ? ' ⭐' : ''}`
    $slots.appendChild(div)
  })
  document.getElementById('room-code').textContent = currentRoom.code
}
function createRoom(joinCode = null) {
  // CPU names (chosen randomly, can repeat across rooms — name tags disambiguate)
  const cpuNames = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Theta', 'Iota']
  const shuffled = [...cpuNames].sort(() => Math.random() - 0.5)
  currentRoom = {
    code: joinCode || makeRoomCode(),
    players: [
      { kind: 'you', name: 'You' },
      { kind: 'ai',  name: `CPU ${shuffled[0]}` },
      { kind: 'ai',  name: `CPU ${shuffled[1]}` },
      { kind: 'ai',  name: `CPU ${shuffled[2]}` },
      { kind: 'ai',  name: `CPU ${shuffled[3]}` },
      { kind: 'ai',  name: `CPU ${shuffled[4]}` },
      { kind: 'ai',  name: `CPU ${shuffled[5]}` },
      { kind: 'ai',  name: `CPU ${shuffled[6]}` },
    ],
  }
  document.getElementById('multi-home').style.display = 'none'
  document.getElementById('multi-room').style.display = 'flex'
  renderRoom()
}
document.getElementById('create-room-btn').addEventListener('click', () => createRoom())
document.getElementById('join-room-btn').addEventListener('click', () => {
  const code = document.getElementById('join-code-input').value.trim().toUpperCase()
  if (code.length !== 6) { SFX.hit(); return }
  createRoom(code)
})
document.getElementById('leave-room-btn').addEventListener('click', () => {
  currentRoom = null
  document.getElementById('multi-home').style.display = 'flex'
  document.getElementById('multi-room').style.display = 'none'
})
document.getElementById('start-multi-btn').addEventListener('click', startGame)

// Re-render shop when entering it; refresh menu stats when returning
document.querySelectorAll('[data-go="shop"]').forEach(b =>
  b.addEventListener('click', renderShop, { capture: false }))
document.querySelectorAll('[data-go="menu"]').forEach(b =>
  b.addEventListener('click', refreshCoinDisplays, { capture: false }))

// ─── Tutorial ────────────────────────────────────────────────────────────────
const isTouch = window.matchMedia('(pointer: coarse)').matches
function showTutorial() {
  // Adapt control hints to the device
  const $move = document.getElementById('tut-move')
  const $use  = document.getElementById('tut-use')
  if (isTouch) {
    if ($move) $move.textContent = 'tap ◀ / ▶ buttons (or swipe)'
    if ($use)  $use.innerHTML   = 'tap the ⚡ button to use it'
  }
  document.getElementById('tutorial-screen').classList.add('show')
}
document.getElementById('tutorial-ok').addEventListener('click', () => {
  document.getElementById('tutorial-screen').classList.remove('show')
  profile.seenTutorial = true
  saveProfile()
})
document.getElementById('how-to-play-btn').addEventListener('click', showTutorial)

// Initial setup
renderShop()
initSettings()
refreshCoinDisplays()
showScreen('menu')
// First-ever launch → show the tutorial over the menu
if (!profile.seenTutorial) showTutorial()

// ─── Helpers ─────────────────────────────────────────────────────────────────
// ─── Crane / respawn ────────────────────────────────────────────────────────
const RESPAWN_TIME    = 1.6   // seconds suspended + lowered
const RESPAWN_HEIGHT  = 7     // start height above track
const CRANE_CABLE_LEN = 12    // tall enough to overhang
function makeCrane() {
  const g = new THREE.Group()
  // Cable (thin vertical line)
  const cable = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, CRANE_CABLE_LEN, 6),
    new THREE.MeshBasicMaterial({ color: 0x222222 })
  )
  cable.position.y = CRANE_CABLE_LEN / 2
  g.add(cable)
  // Hook (small yellow box)
  const hook = new THREE.Mesh(
    new THREE.BoxGeometry(0.6, 0.25, 0.6),
    new THREE.MeshPhongMaterial({ color: 0xffe234, emissive: 0x664400 })
  )
  hook.position.y = 0.15
  g.add(hook)
  scene.add(g)
  return g
}
function safeLaneX(z) {
  // One-sided zone → center of the open half
  for (const [a, b, openSide] of ONE_SIDED_ZONES) {
    if (z <= a + 4 && z >= b - 4) return (openSide === 'L' ? -1 : 1) * (TRACK_WIDTH / 4)
  }
  // Center-void zone → middle of an edge strip (NOT the empty center)
  for (const [a, b, gap] of CENTER_VOID_ZONES) {
    if (z <= a + 4 && z >= b - 4) {
      const w = widthAt(z)
      return (w * gap / 2 + w / 2) / 2   // mid of the right edge lane
    }
  }
  return 0
}
function triggerRespawn(o) {
  if (o.respawn > 0 || o.finished) return
  o.respawn = RESPAWN_TIME
  o.vx = 0; o.vy = 0; o.boost = 0; o.slow = 0; o.fellOff = false
  // Respawn where the ball LEFT the track, not where it drifted to while falling,
  // so a ball that fell behind you doesn't reappear ahead of you.
  const rz = (o.lastSafeZ !== undefined) ? o.lastSafeZ : o.z
  o.z = rz
  o.x = safeLaneX(rz)
  o.y = RESPAWN_HEIGHT
  if (!o.crane) o.crane = makeCrane()
  o.crane.position.set(o.x, RESPAWN_HEIGHT, o.z)
}

function onPad(x, z) {
  for (const p of padData) {
    if (p.used) continue
    if (Math.abs(x - p.x) < p.halfW && Math.abs(z - p.z) < p.halfL) return p
  }
  return null
}
// (replaced by rampAt() / rampSurfaceY())
function hitItemBox(x, z) {
  for (let i = 0; i < itemData.length; i++) {
    const o = itemData[i]
    if (o.taken) continue
    const dx = x - o.x, dz = z - o.z
    if (dx*dx + dz*dz < (o.r + BALL_RADIUS) * (o.r + BALL_RADIUS)) return i
  }
  return -1
}

// ─── Game loop ───────────────────────────────────────────────────────────────
const clock = new THREE.Clock()

function animate() {
  requestAnimationFrame(animate)
  const dt = Math.min(clock.getDelta(), 0.05)

  // RACING and CINEMATIC share the simulation; only camera differs
  if (state === 'RACING' || state === 'CINEMATIC') {
    // ── Race countdown (started when 1st place crossed) ──
    if (firstFinishT > 0) {
      const remaining = COUNTDOWN_S - (clock.elapsedTime - firstFinishT)
      const $cd = document.getElementById('countdown')
      const secs = Math.max(0, Math.ceil(remaining))
      document.getElementById('countdown-num').textContent = secs
      $cd.classList.toggle('urgent', secs <= 3)
      if (remaining <= 0) {
        // DNF anyone still racing; rank them by how far they got (closest to finish first)
        const stragglers = [player, ...aiBalls].filter(o => !o.finished)
        stragglers.sort((a, b) => a.z - b.z)   // smaller z = further along = better
        let dnfOrder = finishedCount
        stragglers.forEach(o => {
          o.finished = true
          o.dnf = true
          dnfOrder++
          o.order = dnfOrder
        })
        firstFinishT = 0   // stop the countdown
        $cd.classList.remove('show', 'urgent')
        // If player hadn't entered cinematic yet (i.e. wasn't the one who crossed),
        // start it now so the result screen comes up cleanly.
        if (state === 'RACING') startCinematic()
      }
    }

    // ── Player ──
    if (!player.finished && player.respawn <= 0) {
      const targetVx = keys.left ? -LATERAL_SPEED : (keys.right ? LATERAL_SPEED : 0)
      player.vx += (targetVx - player.vx) * Math.min(dt * 14, 1)
      player.x  += player.vx * dt

      const speedMult = player.boost > 0 ? BOOST_MULT : (player.slow > 0 ? 0.45 : 1)
      player.z -= PLAYER_SPEED * speedMult * dt
      if (player.boost > 0) player.boost = Math.max(0, player.boost - dt)
      if (player.slow  > 0) player.slow  = Math.max(0, player.slow  - dt)

      // Unified vertical physics – handles jump pads AND off-edge falls
      const wHalf = widthAt(player.z) / 2
      const inVoid = activeWall(player.x, player.z) !== null || inCenterVoid(player.x, player.z)
      // Outer edge gets a grace margin so grazing the guard rail doesn't drop you;
      // you only fall once clearly pushed past it. Interior voids stay strict.
      const onTrack = Math.abs(player.x) <= wHalf + RAIL_GRACE && !inVoid
      const airborne = !player.onRamp && (player.y > BALL_RADIUS + 0.001 || player.vy !== 0 || !onTrack)
      if (airborne) {
        if (!onTrack && player.vy === 0 && Math.abs(player.y - BALL_RADIUS) < 0.001) SFX.fall()
        player.vy -= 32 * dt
        player.y += player.vy * dt
        // Land whenever descending onto solid track from a sane height. The lower
        // bound (y > -1.2) means a ball that already dropped into a pit can't climb
        // back out — but a normal jump always lands cleanly on solid floor.
        if (onTrack && player.vy < 0 && player.y <= BALL_RADIUS && player.y > -1.2) {
          if (player.vy < -8) SFX.land()
          player.y = BALL_RADIUS; player.vy = 0
        }
        if (player.y < -8) triggerRespawn(player)
      }
      // Remember the last grounded, on-track position for respawns
      if (onTrack && player.y <= BALL_RADIUS + 0.05) player.lastSafeZ = player.z

      // Pad detection
      const pad = onPad(player.x, player.z)
      if (pad) {
        const wasBoosting = player.boost > 0
        player.boost = Math.max(player.boost, BOOST_TIME)
        pad.used = true
        const idx = padData.indexOf(pad)
        padMeshes[idx].visible = false
        if (!wasBoosting) SFX.pad()
      }
      // Ramp surface following — ball climbs the slope, launches on exit
      const ramp = rampAt(player.x, player.z)
      if (ramp) {
        const surfY = ramp.peakY * (ramp.zBack - player.z) / (ramp.zBack - ramp.zFront)
        player.y = surfY + BALL_RADIUS
        player.vy = 0
        player.lastRampSlope = ramp.slope
        if (!player.onRamp) SFX.jump()
        player.onRamp = true
      } else if (player.onRamp) {
        // Just exited the ramp — launch
        const fwd = PLAYER_SPEED * (player.boost > 0 ? BOOST_MULT : 1)
        player.vy = fwd * (player.lastRampSlope || 0.3) * 1.7
        player.onRamp = false
      }
      // (No wall push-back — blocked half is just empty air; ball will fall via gravity)
      // Item-box pickup → grants a random weapon (only if you don't already hold one)
      const ibi = hitItemBox(player.x, player.z)
      if (ibi >= 0) {
        const o = itemData[ibi]
        o.taken = true
        itemMeshes[ibi].visible = false
        SFX.item()
        if (!playerWeapon) {
          playerWeapon = Math.random() < 0.5 ? 'speed' : 'missile'
          boostCharge = BOOST_FILL
          updateWeaponUI()
        }
      }

      // Visual: halo for boost
      player.mesh.userData.halo.material.opacity = player.boost > 0 ? 0.55 : 0
      player.mesh.material.emissive.setHex(player.boost > 0 ? 0xffaa33 : 0x000000)

      // Rolling
      player.mesh.rotation.x -= PLAYER_SPEED * speedMult * dt / BALL_RADIUS
      player.mesh.rotation.z -= player.vx   * dt / BALL_RADIUS

      if (player.z <= FINISH_Z) {
        player.finished = true
        player.boost = 0                       // boost off at the goal
        player.coastV = PLAYER_SPEED            // coast in at base speed, no boost carry-over
        player.mesh.userData.halo.material.opacity = 0
        player.mesh.material.emissive.setHex(0x000000)
        recordFinish(player)
        SFX.finish()
        startCinematic()
      }
    }

    // ── AI ──
    // Front-most position in the field (smaller z = further along). Trailing balls
    // rubber-band toward this so the pack stays together and everyone can finish.
    let leaderZ = player.z
    aiBalls.forEach(b => { if (b.z < leaderZ) leaderZ = b.z })

    aiBalls.forEach(b => {
      if (b.finished) return
      if (b.respawn > 0) return  // respawn loop handles AI too
      const aiW = widthAt(b.z)
      const halfSafe = aiW / 2 - BALL_RADIUS - 0.25
      // Look ahead scaled by speed (~1s of travel) so faster balls react sooner
      const look = Math.max(16, b.speed * 1.0)

      // ── Decide desired lane X (priority: survive hazards > grab items > clean line) ──
      let desiredX = b.x
      let hazard = false

      // 1) One-sided zone ahead → aim for the OPEN half centre
      for (const [za, zb, openSide] of ONE_SIDED_ZONES) {
        if (b.z - look <= za && b.z >= zb - 3) {
          desiredX = (openSide === 'L' ? -1 : 1) * (aiW / 4)
          hazard = true; break
        }
      }
      // 2) Center-void ahead → commit to the edge lane the ball is nearer to
      if (!hazard) {
        for (const [za, zb, gap] of CENTER_VOID_ZONES) {
          if (b.z - look <= za && b.z >= zb - 3) {
            const edgeMid = (aiW * gap / 2 + aiW / 2) / 2
            desiredX = (b.x >= 0 ? 1 : -1) * edgeMid
            hazard = true; break
          }
        }
      }
      // 3) No hazard nearby → seek nearest item box / boost pad that's safely reachable
      if (!hazard) {
        let bestDz = look, bestX = null
        for (const it of itemData) {
          if (it.taken) continue
          const dz = b.z - it.z
          if (dz > 0 && dz < bestDz && Math.abs(it.x) < halfSafe) { bestDz = dz; bestX = it.x }
        }
        for (const p of padData) {
          if (p.used) continue
          const dz = b.z - p.z
          if (dz > 0 && dz < bestDz && Math.abs(p.x) < halfSafe) { bestDz = dz; bestX = p.x }
        }
        if (bestX !== null) {
          desiredX = bestX
        } else {
          // gentle weave so the pack doesn't run one identical line
          b.phase += dt * 0.5
          desiredX = Math.sin(b.phase + b.z * 0.02) * (aiW * 0.2)
        }
      }

      desiredX = Math.max(-halfSafe, Math.min(halfSafe, desiredX))

      // ── Decisive proportional steering (much snappier than the old weak spring) ──
      const maxStep = LATERAL_SPEED * (hazard ? 2.2 : 1.5)
      b.vx = Math.max(-maxStep, Math.min(maxStep, (desiredX - b.x) * 6))
      b.x += b.vx * dt

      // ── Forward motion with leader-relative rubber-band (keeps the pack tight) ──
      const gap = b.z - leaderZ                  // >0 means this ball trails the leader
      let catchUp = 1
      if      (gap > 90) catchUp = 1.40          // way behind → strong catch-up
      else if (gap > 50) catchUp = 1.22
      else if (gap > 25) catchUp = 1.10
      else if (gap < 4)  catchUp = 0.93          // at the very front → ease off a touch
      const speedMult = (b.boost > 0 ? BOOST_MULT : (b.slow > 0 ? 0.45 : 1)) * catchUp
      b.z  -= b.speed * speedMult * dt
      if (b.boost > 0) b.boost = Math.max(0, b.boost - dt)
      if (b.slow  > 0) b.slow  = Math.max(0, b.slow  - dt)

      const aiPad = onPad(b.x, b.z)
      if (aiPad) {
        b.boost = Math.max(b.boost, BOOST_TIME)
        aiPad.used = true
        padMeshes[padData.indexOf(aiPad)].visible = false
      }
      const aiBox = hitItemBox(b.x, b.z)
      if (aiBox >= 0) {
        const o = itemData[aiBox]
        o.taken = true
        itemMeshes[aiBox].visible = false
        // 55% speed boost, 45% missile (only fires if there's someone in front)
        if (Math.random() < 0.55) {
          b.boost = Math.max(b.boost, BOOST_TIME)
        } else {
          const ahead = aiBalls.some(o2 => !o2.finished && o2.respawn <= 0 && o2.z < b.z) || (!player.finished && player.respawn <= 0 && player.z < b.z)
          if (ahead) { fireMissile(b); SFX.missile() }
          else       { b.boost = Math.max(b.boost, BOOST_TIME) }
        }
      }

      b.mesh.userData.halo.material.opacity = b.boost > 0 ? 0.4 : 0
      b.mesh.material.emissive.setHex(b.boost > 0 ? 0xffaa33 : 0x000000)
      b.mesh.rotation.x -= b.speed * speedMult * dt / BALL_RADIUS
      b.mesh.rotation.z -= b.vx * dt / BALL_RADIUS

      // AI ramp surface following
      const aRamp = rampAt(b.x, b.z)
      if (aRamp) {
        const surfY = aRamp.peakY * (aRamp.zBack - b.z) / (aRamp.zBack - aRamp.zFront)
        b.y = surfY + BALL_RADIUS
        b.vy = 0
        b.lastRampSlope = aRamp.slope
        b.onRamp = true
      } else if (b.onRamp) {
        const fwd = b.speed * (b.boost > 0 ? BOOST_MULT : 1)
        b.vy = fwd * (b.lastRampSlope || 0.3) * 1.7
        b.onRamp = false
      }
      // (one-sided avoidance handled by AI target picking above)
      // Unified vertical physics (one-sided void counts as off-track)
      const aiHalf = widthAt(b.z) / 2
      const aiInVoid = activeWall(b.x, b.z) !== null || inCenterVoid(b.x, b.z)
      const aiOnTrack = Math.abs(b.x) <= aiHalf + RAIL_GRACE && !aiInVoid
      const aiAirborne = !b.onRamp && (b.y > BALL_RADIUS + 0.001 || b.vy !== 0 || !aiOnTrack)
      if (aiAirborne) {
        b.vy -= 32 * dt
        b.y += b.vy * dt
        if (aiOnTrack && b.vy < 0 && b.y <= BALL_RADIUS && b.y > -1.2) { b.y = BALL_RADIUS; b.vy = 0 }
        if (b.y < -8) triggerRespawn(b)
      }
      if (aiOnTrack && b.y <= BALL_RADIUS + 0.05) b.lastSafeZ = b.z

      if (b.z <= FINISH_Z) {
        b.finished = true
        b.boost = 0
        b.coastV = b.speed
        b.mesh.userData.halo.material.opacity = 0
        b.mesh.material.emissive.setHex(0x000000)
        recordFinish(b)
      }
    })

    // ── Ball collision (separation + ram knockback) ──
    const all = [player, ...aiBalls]
    const fwdSpeed = (o) => {
      if (o.finished || o.respawn > 0) return 0
      const base = o === player ? PLAYER_SPEED : o.speed
      const mult = o.boost > 0 ? BOOST_MULT : (o.slow > 0 ? 0.45 : 1)
      return base * mult
    }
    for (let a = 0; a < all.length - 1; a++) {
      for (let bb = a + 1; bb < all.length; bb++) {
        const ba = all[a], bbo = all[bb]
        if (ba.respawn > 0 || bbo.respawn > 0) continue
        if (ba.finished || bbo.finished) continue   // frozen finishers don't collide
        const dx = ba.x - bbo.x, dz = ba.z - bbo.z
        const d2 = dx * dx + dz * dz
        const minD = BALL_RADIUS * 2.1
        if (d2 < minD * minD && d2 > 0.0001) {
          const d = Math.sqrt(d2)
          const push = (minD - d) * 0.5
          const nx = dx / d, nz = dz / d
          // Soft separation
          ba.x  += nx * push; ba.z  += nz * push * 0.2
          bbo.x -= nx * push; bbo.z -= nz * push * 0.2

          // Knockback: faster ball ramming slower one (mass-equal impulse)
          const sa = fwdSpeed(ba), sb = fwdSpeed(bbo)
          const aBehind = ba.z > bbo.z          // a is behind b along -z
          const fast = aBehind ? ba : bbo
          const slow = aBehind ? bbo : ba
          const sFast = aBehind ? sa : sb
          const sSlow = aBehind ? sb : sa
          const diff = sFast - sSlow
          // Boosting ball gets extra ram power
          const boostBonus = fast.boost > 0 ? 2.0 : 1.0
          if (diff > 2.5) {
            // Direction from fast → slow in (x,z)
            const dirX = slow.x - fast.x
            const dirZ = slow.z - fast.z
            const dLen = Math.hypot(dirX, dirZ) || 1
            const ux = dirX / dLen, uz = dirZ / dLen
            const impulse = (diff * 1.8 + 14) * boostBonus
            // Strong lateral kick → launches over barriers / into voids
            slow.vx += ux * impulse
            // Big vertical pop so the ram visibly throws the ball into the air
            slow.vy = Math.max(slow.vy, 13 + Math.min(diff, 12) * 0.7)
            slow.slow = Math.max(slow.slow, 0.35)
            // Slight stutter on the rammer
            fast.slow = Math.max(fast.slow, 0.08)
            // Visual flash
            slow.mesh.material.emissive.setHex(0xffaa44)
            SFX.hit()
          }
        }
      }
    }

    // ── Coin pickup ──
    const pxz2 = (x, z) => (player.x - x) ** 2 + (player.z - z) ** 2
    coinData.forEach((c, i) => {
      if (c.collected) return
      coinMeshes[i].rotation.y += dt * 2.5
      if (pxz2(c.x, c.z) < 1.4) {
        c.collected = true
        coinMeshes[i].visible = false
        coinsCollected++
        SFX.coin()
        if (!playerWeapon) {
          boostCharge++
          if (boostCharge >= BOOST_FILL) {
            playerWeapon = Math.random() < 0.5 ? 'speed' : 'missile'
          }
          updateWeaponUI()
        }
      }
    })

    // ── Pad spin animation ──
    padData.forEach((p, i) => {
      const m = padMeshes[i]
      m.material.opacity = 0.65 + Math.sin(clock.elapsedTime * 4 + i) * 0.25
    })

    // ── Item box: spin + bob (no respawn — one-shot) ──
    itemData.forEach((o, i) => {
      if (o.taken) return
      const m = itemMeshes[i]
      m.rotation.y += dt * 1.8
      m.position.y = 0.6 + Math.sin(clock.elapsedTime * 3 + i) * 0.08
    })

    // ── Finishers coast inward past the line, then stop ──
    for (const o of [player, ...aiBalls]) {
      if (o.finished && o.coastV > 0) {
        o.z -= o.coastV * dt
        o.coastV = Math.max(0, o.coastV - 70 * dt)   // decelerate to a stop
        o.mesh.rotation.x -= o.coastV * dt / BALL_RADIUS
        if (o.z < FINISH_Z - 8) { o.z = FINISH_Z - 8; o.coastV = 0 }  // cap roll-in
      }
    }

    // ── Sync mesh positions (y can drop when off-edge) ──
    player.mesh.position.set(player.x, player.y, player.z)
    aiBalls.forEach(b => b.mesh.position.set(b.x, b.y, b.z))

    // ── Missiles ──
    for (let i = missiles.length - 1; i >= 0; i--) {
      const m = missiles[i]
      m.life -= dt
      m.z -= m.speed * dt
      // Candidate targets: everyone except the owner, must be ahead of missile and alive
      const candidates = [player, ...aiBalls].filter(o =>
        o !== m.owner && !o.finished && o.respawn <= 0 && o.z < m.z
      )
      // Home toward the LEADER (front-most ball ahead) — but the hit-check below
      // still collides with ANY ball it passes through on the way there.
      let target = null, bestZ = Infinity
      for (const o of candidates) {
        if (o.z < bestZ) { bestZ = o.z; target = o }
      }
      if (target) {
        const tx = target.x
        m.x += Math.sign(tx - m.x) * Math.min(Math.abs(tx - m.x), 30 * dt)
      }
      m.mesh.position.set(m.x, BALL_RADIUS, m.z)
      m.trail.position.set(m.x, BALL_RADIUS, m.z + 0.6)
      m.trail.material.opacity = 0.4 + Math.random() * 0.3

      let hit = null
      for (const o of candidates) {
        const dx = o.x - m.x, dz = o.z - m.z
        if (dx*dx + dz*dz < 1.2) { hit = o; break }
      }
      if (hit || m.life <= 0 || m.z < FINISH_Z - 5) {
        if (hit) {
          hit.boost = 0          // cancel any active boost — missiles always bite
          hit.slow = 1.8         // longer stun than a ram
          const sign = hit.x >= 0 ? 1 : -1
          hit.vx = sign * 12
          hit.vy = Math.max(hit.vy, 20)  // big launch into the air = real time penalty
          hit.mesh.material.emissive.setHex(0xff4444)
          SFX.hit()
          // Show "[attacker]가 [victim]를 맞췄습니다!" if the player is involved
          if (m.owner === player || hit === player) showHitToast(m.owner, hit)
        }
        scene.remove(m.mesh); scene.remove(m.trail)
        missiles.splice(i, 1)
      }
    }

    // ── Respawn (crane) tick for all balls ──
    for (const o of [player, ...aiBalls]) {
      if (o.respawn <= 0) continue
      o.respawn -= dt
      const t = 1 - o.respawn / RESPAWN_TIME   // 0 → 1 over the duration
      // Lower the ball from RESPAWN_HEIGHT down to BALL_RADIUS
      o.y = RESPAWN_HEIGHT - (RESPAWN_HEIGHT - BALL_RADIUS) * Math.min(1, t * 1.1)
      // Sway slightly while suspended
      const sway = Math.sin(clock.elapsedTime * 6) * 0.08 * (1 - t)
      if (o.crane) o.crane.position.set(o.x, RESPAWN_HEIGHT, o.z)
      o.mesh.position.set(o.x + sway, o.y, o.z)
      if (o.respawn <= 0) {
        if (o.crane) { scene.remove(o.crane); o.crane = null }
        o.y = BALL_RADIUS; o.vy = 0; o.vx = 0
        SFX.land()
      }
    }

    // ── Speed lines fade + zoom (Kart-Rider converge) ──
    const targetSL = player.boost > 0 ? 1.0 : 0
    speedLines.material.opacity += (targetSL - speedLines.material.opacity) * Math.min(dt * 9, 1)
    // Spin slowly + animate scale to make lines appear to rush inward
    speedLines.rotation.z -= dt * 0.6
    const pulse = 1 + Math.sin(clock.elapsedTime * 18) * 0.06
    const baseScale = 0.85 + (1 - Math.min(1, speedLines.material.opacity)) * 0.4
    speedLines.scale.setScalar(baseScale * pulse)

    // ── Camera ──
    if (state === 'CINEMATIC') {
      const tc = clock.elapsedTime - cineStart
      const sway = Math.sin(tc * 0.35) * 1.5
      const bob  = Math.sin(tc * 0.5)  * 0.4
      const dolly = Math.max(0, 4 - tc) * 1.5
      camera.position.lerp(new THREE.Vector3(sway, 5.5 + bob, FINISH_Z - 14 - dolly), dt * 2.5)
      camera.lookAt(0, 1.2, FINISH_Z + 14)

      const remaining = aiBalls.filter(b => !b.finished).length
      if (tc > CINEMATIC_S || remaining === 0) showFinish()
    } else {
      const tCamX = player.x * 0.25
      const tCamZ = player.z + (player.boost > 0 ? 9.5 : 8)
      camera.position.lerp(new THREE.Vector3(tCamX, 3.5, tCamZ), dt * 10)
      camera.lookAt(player.x * 0.15, 0, player.z - 18)

      // ── HUD (only during active racing) ──
      const progress = Math.max(0, (2 - player.z) / (2 + Math.abs(FINISH_Z)))
      $rankTxt.textContent  = ordinal(getLiveRank())
      $coinTxt.textContent  = coinsCollected
      $progFill.style.width = `${(progress * 100).toFixed(1)}%`
      allBalls.forEach((b, i) => {
        const p = Math.max(0, Math.min(1, (2 - b.z) / (2 + Math.abs(FINISH_Z))))
        markerEls[i].style.left = (p * 100).toFixed(1) + '%'
      })
    }

  } else if (state === 'MENU') {
    const t = clock.elapsedTime
    camera.position.set(Math.sin(t * 0.18) * 5, 4.5, 14)
    camera.lookAt(0, 0.5, -6)
  }

  renderer.render(scene, camera)
}

animate()
