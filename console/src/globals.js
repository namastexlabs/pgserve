// Bootstrap React onto globalThis BEFORE any screen module evaluates.
//
// Why a separate file: ESM hoists `import` statements above sibling
// top-level code in the importer. If we did `globalThis.React = React`
// inline inside main.jsx (alongside `import './screens/databases.jsx'`
// etc.), the screen modules would execute first and reference bare
// identifiers like `useState` against an unprepared globalThis,
// crashing with "ReferenceError: React is not defined".
//
// Importing this module first guarantees its body runs to completion
// before any subsequent import — the fixed-up globalThis is then
// visible to every screen module that references React/useState/etc.
// as a free identifier.
import React from 'react';
import * as ReactDOM from 'react-dom/client';

Object.assign(globalThis, {
  React,
  ReactDOM,
  // Spread named React exports so screens can reference `useState`,
  // `useEffect`, `useMemo`, `useRef`, `useCallback`, `Fragment`, etc.
  // as bare identifiers without explicit `React.` qualification.
  ...React,
});
