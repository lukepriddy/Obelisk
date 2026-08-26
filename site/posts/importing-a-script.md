---
title: Importing a finished script into a location-based experience
slug: importing-a-script
date: 2026-08-17
description: Paste a whole document and get back a set of geofenced zones with your text in them. How it works, and why the AI never touches a word of it.
---

Most people who build a walk write the whole thing first. A document, in order,
with the dialogue and the puzzles and the notes to self.

Then comes the slow part. You open the builder, make a zone, copy a paragraph
in, write a description, pick a voice, and then do the same thing again for
every other stop.

On a walk with twenty stops that is most of a working day, and none of it is
writing.

## Pasting the document instead

Now you paste the document in and it comes back as a map. It works out where
each stop begins and ends, who is speaking, and what belongs together. Your
words are copied across exactly as you wrote them.

## Why the AI does not touch your text

Real scripts are full of things that break if they get reworded even slightly.
A password the player has to type. A code that only works in one order. A
phrase planted in stop two that pays off in stop fourteen.

So the AI only reports where each stop starts and ends, by line number. Our
server does the cutting. The AI never handles your text, which means it cannot
change it.

## Instructions in the document

You can also write instructions into the document on their own line. Make this
one a character. Lock this one with this password. Hide this one from the map.
Make this zone six feet wide.

Those lines are removed before any of the text is used, so a player never hears
them.
