/**
 * BrandMark — the Obelisk pin, in one place.
 *
 * It was drawn five times across the app in three different greens: emerald-400
 * on the sign-in and legal pages, emerald-500 on the report page, a dark pin on
 * a filled emerald tile on the dashboard, and the tour's own accent colour in
 * the player. None of them matched the logo file.
 *
 * Rendered as an inline SVG rather than an <img> of the supplied PNG. The shape
 * is the same lucide MapPin outline the logo is drawn from, so this is crisp at
 * every size, costs no network request, and cannot fail to load — which matters
 * for a mark that appears at 16-24px in a header. The PNG is still the source
 * of truth for the favicon and home-screen icons, where a real image is needed.
 *
 * BRAND_GREEN is sampled from the logo file itself, not guessed: #07b981 is the
 * dominant colour across its 183,497 opaque pixels. It is deliberately distinct
 * from the platform accent (#10b981, Tailwind emerald-500), which remains the
 * default a creator's experience inherits.
 */

import React from 'react';

/** Sampled from public/icons/Obelisk Logo.png. */
export const BRAND_GREEN = '#07b981';

interface BrandMarkProps {
  /** Rendered box in px. Matches the size each call site already used. */
  size?: number;
  /** Overrides the brand colour. Only for surfaces that must theme it. */
  color?: string;
  className?: string;
}

export const BrandMark: React.FC<BrandMarkProps> = ({
  size = 24,
  color = BRAND_GREEN,
  className,
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
    focusable="false"
  >
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
    <circle cx="12" cy="10" r="3" />
  </svg>
);
