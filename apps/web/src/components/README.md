# Web component structure

Every React component must live in its own folder. Use the following layout:

```text
component-name/
├── index.tsx
├── component-name.css     # required when the component owns styles
└── component-name.test.ts # optional
```

Rules:

1. Do not add standalone component `.tsx` files directly under `components/`, `pages/`, `app/`, or a feature folder.
2. Import component-specific CSS from the component's own `index.tsx`.
3. Keep only theme tokens, resets, and genuinely shared layout primitives in the global stylesheets.
4. Use `components/ui/index.ts` as the public barrel for UI primitives; each primitive still owns a separate folder.
5. Colocate component-specific tests and helpers when they are not shared by other components.

`component-structure.test.ts` enforces the first two rules.
