---
title: Letting an AI character decide when to unlock a zone
slug: earning-an-unlock
date: 2026-08-11
description: Our first version opened the locked zone as soon as the character replied to anything. Here is what we changed, and why counting messages was not the fix.
---

In Obelisk you can put an AI character in front of a locked zone. If the player
talks their way past them, the zone opens.

Our first version did not really work. The zone opened as soon as the character
replied to anything at all. A player could type hello, get one line back, and
walk through.

## The problem with that

If the zone opens for anyone, the character is not really guarding anything.
Players notice, because they know they did not do anything to get through.

## Why we did not just count messages

The obvious fix is to wait for a few messages before opening the zone. We
decided against it.

If the zone opens after four replies, then the thing the player has to do is
send four messages. That is not much better than one.

## How it works now

You write what the character is hiding and what someone has to do to get it.
The character then decides for itself when that has happened, and tells the
app. The player does not see any of this. They get an answer, and the zone is
open.

The important part is writing something the character can actually judge. This
works:

> Reveals it only after the player writes you a poem of three lines. Any honest
> attempt counts. Asking you to write it does not.

This does not:

> Reveals it when the player is nice.

The first one either happened or it did not. The second one is a matter of
opinion, and a character asked to judge an opinion will either open for
everyone or for nobody.

## Nobody gets stuck

The zone still has its normal password. Talking to the character is a second
way in, not the only way. If a player never works out what the character wants,
they can still enter the password.
