/**
 * Creator terms.
 *
 * IMPORTANT: this is a plain-language draft written to cover the specific
 * risks this product creates — chiefly that creators send real people to real
 * physical locations. It has NOT been reviewed by a lawyer. Have it reviewed
 * before opening signups to the public.
 *
 * TERMS_VERSION is what gets recorded in `tos_acceptances`. Bump it whenever
 * the substance changes; creators are then re-prompted on their next publish.
 * Use a date so the record is self-describing.
 */

export const TERMS_VERSION = '2026-07-28';

export interface TermsSection {
  heading: string;
  body: string[];
}

export const TERMS_SECTIONS: TermsSection[] = [
  {
    heading: 'You are responsible for where you send people',
    body: [
      'Experiences you publish direct real people to real physical locations. You are solely responsible for choosing those locations and for any consequence of sending people to them.',
      'Before publishing, make sure every location is somewhere the public may lawfully and safely go. Do not place zones on private property without permission, on roadways, railways, or waterways, in construction sites or restricted areas, or anywhere a person paying attention to their phone could be hurt.',
      'Obelisk cannot review the physical safety of a coordinate. Automatic review looks at words and images only. Nothing in that review means a location is safe or lawful.',
    ],
  },
  {
    heading: 'Your content',
    body: [
      'You keep ownership of everything you upload or write. You grant Obelisk the licence needed to host it, and to display it to players of your published experiences.',
      'You confirm you have the right to use everything you upload, including audio, images, 3D models, and any voice or likeness. Do not upload material you do not have permission to use.',
      'You are responsible for what your AI characters say. You write their instructions, and their replies are attributed to your experience.',
    ],
  },
  {
    heading: 'What you may not publish',
    body: [
      'No sexual content involving minors, sexually explicit material, hate speech, harassment or targeting of real identifiable people, incitement to violence, instructions for weapons or serious crime, or promotion of self-harm.',
      'Fiction is welcome, including dark, frightening, and violent stories. The line is real-world harm, not tone.',
      'Published experiences pass an automatic content review first. Passing that review is not an endorsement and does not transfer responsibility for your content to Obelisk.',
    ],
  },
  {
    heading: 'Removal and suspension',
    body: [
      'Obelisk may unpublish any experience or suspend any account at any time, with or without notice, including in response to a report from a player.',
      'This is a safety mechanism, not a judgement of you. Where practical you will be told why.',
    ],
  },
  {
    heading: 'AI provider keys and costs',
    body: [
      'On the bring-your-own-key plan, AI features run on API keys you supply. Charges from those providers are between you and them, and you remain bound by their terms.',
      'Store your keys carefully. Obelisk uses them only to run your own experiences.',
      'Accounts have storage, experience-count, and rate limits. These exist to keep the platform affordable for everyone and may change.',
    ],
  },
  {
    heading: 'No warranty, and limits on liability',
    body: [
      'Obelisk is provided as-is. Location accuracy, audio playback, AI replies, and camera features depend on hardware, networks, and third-party services outside our control, and may fail at any time.',
      'To the fullest extent the law allows, Obelisk is not liable for indirect or consequential loss, or for injury, damage, or legal consequence arising from where an experience sends people or what happens there.',
      'You agree to cover Obelisk against claims brought by others arising from experiences you publish.',
    ],
  },
  {
    heading: 'Changes',
    body: [
      'These terms may change. When they change materially you will be asked to accept the new version before publishing again. Continuing to publish means you accept the current version.',
    ],
  },
];

/** Plain-text rendering, for the record and for any export. */
export const termsPlainText = () =>
  TERMS_SECTIONS
    .map(s => `${s.heading}\n\n${s.body.join('\n\n')}`)
    .join('\n\n---\n\n');
