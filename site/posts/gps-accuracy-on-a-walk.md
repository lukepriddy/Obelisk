---
title: GPS is a guess, and what that means for a location-based experience
slug: gps-accuracy-on-a-walk
date: 2026-08-23
description: A phone's location is not accurate for the first few seconds. Here is why that breaks a geolocated audio experience, and what we do about it.
---

A phone does not know exactly where it is. It makes a guess from the satellites
and the wifi around it, and that guess gets more accurate over the first few
seconds.

## Why this matters for a walk

If your first zone is small, it can go wrong right at the start. Either nothing
plays while the player is standing in the right place, or something plays while
they are still in the car park.

To the player this does not look like a GPS problem. It looks like the
experience is broken.

## What Obelisk does

Obelisk does not show the map straight away. It holds a screen in front of the
walk while the signal settles, and shows a ring that tightens as the reading
gets better. When the reading is good enough, the walk begins.

It usually takes a few seconds, which is about how long it takes to put
headphones in. After that the first zone plays in the right place.

## Drift after that

Even once the signal settles it still moves around a little. So a zone is
slightly harder to leave than it is to enter. Without that, standing still can
be enough for the app to decide you have walked away and stop the audio.
