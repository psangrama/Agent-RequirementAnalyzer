# Product Requirements Document (PRD): Micro Racers

## 1. Executive Summary

**Micro Racers** is a lightweight, arcade-style 2D top-down car game designed for quick, session-based gameplay on web browsers and low-spec mobile devices. The core gameplay loop focuses on simple steering mechanics, obstacle avoidance, coin collection, and short-circuit lap challenges.

## 2. Goals & Success Metrics

### Business & User Goals

* Deliver an instantly playable experience with zero install friction (web-first via HTML5/Canvas or WebGL).

* Achieve high replayability through procedural track obstacles and short (30–90 second) play sessions.

* Create a lightweight foundation that can scale into local multiplayer or cosmetic monetization.

### Key Performance Indicators (KPIs)

* **Performance:** Stable 60 FPS on low-end hardware (e.g., standard smartphone browsers, budget laptops).

* **Initial Load Time:** Under 3 seconds on standard 4G networks (bundle size < 10 MB).

* **Engagement:** Average session length $\ge$ 4 minutes (3–5 consecutive runs).

* **Retention:** Day 1 retention $\ge$ 25%.

## 3. User Personas

| **Attribute** | **Persona A: Casual Commuter** | **Persona B: Arcade High-Scorer** | 
| **Age / Role** | 18–35, Mobile/Browser casual gamer | 16–30, Competitive gamer | 
| **Goal** | Quick mental break during transit or downtime | Master physics/drifting to top the leaderboard | 
| **Play Style** | 1–2 quick runs, single-handed controls | Repeated attempts to optimize lap lines and score | 
| **Key Need** | Instant responsiveness, no complex tutorials | Tight collision boxes, consistent physics | 

## 4. Game Overview & Mechanics

### 4.1 Core Game Loop

1. **Start Screen:** Player selects an unlocked vehicle and clicks "Play".

2. **Race Loop:**

   * Vehicle auto-accelerates or accelerates via simple input.

   * Player steers left/right and manages drift/brake.

   * Collect coins and fuel/nitro pickups while dodging obstacles (oil slicks, roadblocks, AI traffic).

3. **Run Termination:** Car runs out of health (from crashes) or timer expires.

4. **End Game / Summary:** Displays score, distance, coins collected, and High Score comparison. Option to restart immediately.

### 4.2 Controls Specification

* **Desktop:**

  * `Arrow Keys` or `WASD`: Steer, Accelerate, Brake/Reverse.

  * `Spacebar`: Handbrake / Drift.

* **Mobile / Touch:**

  * Virtual on-screen D-pad / left-right buttons on the bottom-left.

  * Gas / Brake / Boost pedals on the bottom-right.

  * Optional: Single-touch drag/tilt steering toggle.

### 4.3 Progression & Economy

* **Soft Currency (Coins):** Earned on-track based on distance and direct pickups.

* **Garage / Upgrades:**

  * Top Speed (+5% increments, max 5 tiers).

  * Acceleration (+5% increments, max 5 tiers).

  * Handling / Drift Traction (+5% increments, max 5 tiers).

* **Unlockable Skins:** 3–5 visually distinct vehicles (e.g., Mini Cooper, Muscle Car, Formula Kart).

## 5. Technical Requirements & Architecture

### 5.1 Tech Stack Recommendations

* **Engine / Framework:** Phaser 3 (HTML5/Canvas/WebGL) or Godot 4 (HTML5 export).

* **Physics Engine:** Arcade Physics (Phaser built-in) or lightweight 2D Box2D.

* **Audio:** Howler.js or native Web Audio API for low-latency engine hum and collision sound effects.

* **Persistence:** `localStorage` for high scores, collected coins, and vehicle configurations.

### 5.2 Performance & Compatibility Targets

* Asset optimization via texture atlases (sprite sheets) and compressed audio (`.ogg` / `.mp3`).

* Responsive canvas auto-scaling matching 16:9 landscape on desktop and 9:16 portrait on mobile.

* Zero external authentication required for MVP.

## 6. MVP Feature Scope vs. Post-MVP

```
+-----------------------------------------------------------------------+
| PHASE 1: MVP (Core Prototype)                                        |
|  - Endless runner/track format with procedural obstacles             |
|  - 1 standard vehicle with baseline physics (steering + acceleration)  |
|  - Coin pickups, health counter, distance tracker                     |
|  - Local storage high score                                           |
|  - Responsive desktop and mobile touch controls                       |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
| PHASE 2: Garage & Progression                                         |
|  - 3 total playable vehicles with distinct stat archetypes            |
|  - Garage upgrade shop (spend coins on speed, grip, health)           |
|  - Audio integration (engine loop, screech, coin pickup, crash)       |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
| PHASE 3: Competitive & Live Features                                  |
|  - Global leaderboard via lightweight backend (e.g., Supabase/Firebase)|
|  - Ghost car data / asynchronous time trials                          |
|  - Daily challenge tracks with preset seed layouts                    |
+-----------------------------------------------------------------------+

```

## 7. UX & UI Wireframe Flow

```
[ Title Screen ]
       |
       +---> [ Garage / Select Vehicle ]
       |             |
       v             v
[ Gameplay Canvas ] <+
       |
  (Car Health = 0)
       |
       v
[ Game Over Modal ]
   - Distance / Score
   - Coins Earned
   - Best Score
   - [ Restart ]  [ Garage ]

```

## 8. Open Questions & Risks

* **Physics Tuning:** Balancing realistic vehicle momentum (drifting) vs. responsive arcade steering to prevent frustration on touch screens.

* **Orientation Support:** Deciding whether to lock mobile gameplay to portrait (single-hand play) or landscape (two-hand console feel). Current recommendation is portrait for casual endless-runner style, landscape for circuit-based racing.