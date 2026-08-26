import './brand-mark.css';

export function BrandMark({ large = false }: { large?: boolean }) {
  return (
    <svg
      className={`brand-mark${large ? ' large' : ''}`}
      viewBox="0 0 26 24"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 5C10 5 9.5 12 16 12H21" />
      <path d="M4 19C10 19 9.5 12 16 12" />
      <circle cx="3" cy="5" r="2.25" />
      <circle cx="3" cy="19" r="2.25" />
      <circle cx="23" cy="12" r="2.25" />
    </svg>
  );
}
