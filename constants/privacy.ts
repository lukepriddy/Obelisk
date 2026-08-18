/**
 * Privacy policy.
 *
 * IMPORTANT: like the creator terms, this is a plain-language draft written to
 * describe what Obelisk actually does. It has NOT been reviewed by a lawyer.
 * Precise location data is treated as sensitive personal information in several
 * jurisdictions, so have this reviewed before opening signups publicly.
 *
 * Keep it accurate. A policy that describes collection the product doesn't do —
 * or omits collection it does — is worse than none, because it's a written
 * statement that can be shown to be false.
 *
 * PRIVACY_VERSION is displayed on the page; bump it when the substance changes.
 */

import type { TermsSection } from './terms';

export const PRIVACY_VERSION = '2026-07-28';

export const PRIVACY_SECTIONS: TermsSection[] = [
  {
    heading: 'The short version',
    body: [
      'Obelisk needs your location to work. An experience is a set of real places, and the app has to know when you reach one. Location is used on your device to trigger content, and is not sold, shared with advertisers, or used to build a profile of you.',
      'You can stop at any time by leaving the experience or turning off location access for the site in your browser.',
    ],
  },
  {
    heading: 'What is collected when you play',
    body: [
      'Precise location. While an experience is open, the app reads your GPS position to work out which zones you are near. This is processed as you move and is not stored as a continuous track of where you went.',
      'Play records. Which experience you opened, which zones you reached, and when. These are kept so creators can see how their experience is being used. They are not linked to your name or email, because players do not sign in.',
      'Progress on your own device. Items collected, zones unlocked, and passphrases solved are stored in your browser, not on our servers. Clearing your browser data clears them.',
      'Messages to AI characters. If an experience includes a character you can talk to, what you type is sent to an AI provider to generate a reply. Do not type anything private into a character conversation.',
      'Camera. If an experience offers a camera view, the image is used on your device to draw the scene. Camera images are not uploaded or stored.',
    ],
  },
  {
    heading: 'What is collected when you create',
    body: [
      'Your email address, used to sign in. There is no password.',
      'The experiences you build: text, audio, images, coordinates, and settings.',
      'AI provider keys you choose to add. These are stored so your experiences can run, and are used only for that.',
      'Basic usage counts (storage used, experiences created, AI calls made) to enforce account limits.',
    ],
  },
  {
    heading: 'Who else is involved',
    body: [
      'Obelisk runs on services that necessarily handle some of this data: Supabase (database, sign-in, file storage), Vercel (hosting), and map tile providers. AI features send text and images to Google (Gemini) and, where used, ElevenLabs.',
      'These providers process data to deliver the service. Obelisk does not sell personal information to anyone, and does not share it for advertising.',
    ],
  },
  {
    heading: 'How long things are kept',
    body: [
      'Experiences and uploaded files are kept while the account exists. Delete an experience and its content goes with it.',
      'Play records are kept so creators can see how an experience performs. They contain no identifying details about the player.',
      'Ask and your account and everything in it can be deleted.',
    ],
  },
  {
    heading: 'Your choices',
    body: [
      'Location access can be refused or revoked in your browser at any time. Experiences will not work without it, since the whole point is where you are standing.',
      'To see, correct, or delete what is held about you, get in touch. Depending on where you live you may have a legal right to these things; the request is handled the same way either way.',
    ],
  },
  {
    heading: 'Children',
    body: [
      // This previously spoke only about creating accounts, which covers
      // creators and misses players entirely — and players are the ones whose
      // location is read, with no account anywhere in the flow.
      'Obelisk is not intended for anyone under 13. That applies to playing an experience as well as making one, and accounts should not be created by them.',
      'We do not knowingly collect information from anyone under 13. If we learn that we have, we delete it. Get in touch and we will.',
      'Experiences involve walking to real places. Anyone under 18 should be doing that with a parent or guardian who agrees to it.',
    ],
  },
  {
    heading: 'Changes',
    body: [
      'This policy may change. The version below shows when it was last revised.',
    ],
  },
];
