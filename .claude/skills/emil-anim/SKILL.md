---
name: emil-anim
description: Web animation/motion guidelines (Emil Kowalski-based). Use when designing or auditing UI motion.
---
# Emil-Anim — Web Animation Guidelines
Animation should be invisible: the UI feels good, motion isn't noticed.

## Timing
- Micro-interactions (hover/toggle/press): 150-250ms
- Standard transitions (modal/panel/reveal): 200-350ms
- Complex orchestration: 400-600ms max
- Exit faster than entrance (enter 300 → exit 200)
- Stagger 30-60ms between items; max total 1s

## Easing
- Ease-out for entrances, ease-in for exits, ease-in-out only for repositioning
- Never linear for UI (only progress bars); spring physics for organic motion

## Properties
- Animate ONLY transform & opacity (GPU). Never width/height/margin/padding/position.

## Interaction states
- Hover: instant, 150ms ease-off
- Active/pressed: scale(0.97-0.98)
- Disabled: no animation; Loading: subtle pulse/shimmer (no spinners)

## Entrance/exit
- Reveal: fade + rise (opacity 0→1, translateY 8px→0)
- Modal: scale from 0.96 + opacity; Menu: transform-origin at trigger; Toast: slide from edge + fade

## Required
- Always respect prefers-reduced-motion (mandatory)
- will-change sparingly; movement small (4-16px micro, 20-40px larger); stagger groups 3-7 items
