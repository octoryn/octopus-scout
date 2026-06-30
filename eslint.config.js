// ESLint flat config for octopus-scout.
//
// Pragmatic, NON type-checked ruleset: typescript-eslint's `recommended`
// (fast, fewer false positives) layered on top of `eslint:recommended`.
// The codebase already passes `tsc --strict --noEmit`, so the type system
// covers the heavy correctness checks; ESLint here catches the lint-class
// problems tsc does not (unused locals/imports, accidental constant
// conditions, reassignment of never-reassigned bindings, etc.).
//
// `no-floating-promises` is intentionally NOT enabled: it is type-checked
// only and would require wiring `projectService`, which we deliberately
// avoid to keep lint fast and false-positive-free.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Generated output, deps and coverage artifacts are never linted.
    ignores: ["dist/**", "node_modules/**", "coverage/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module"
    },
    rules: {
      // Catch genuinely unused vars/imports, but allow the conventional
      // leading-underscore opt-out for deliberately-unused params/catches.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true
        }
      ],

      // prefer-const is a real correctness signal (bindings never reassigned).
      "prefer-const": "error",

      // Constant conditions are usually bugs, but `while (true)` worker /
      // polling loops are an intentional pattern across this codebase
      // (queue consumers, retry loops), so allow them.
      "no-constant-condition": ["error", { checkLoops: false }],

      // This is a server/CLI/worker codebase: console is the logging surface
      // in several modules. Not a lint-worthy problem here.
      "no-console": "off",

      // `any` appears at well-considered boundaries (third-party libs without
      // types, dynamic JSON, JSDOM/Turndown interop). tsc --strict already
      // gates the rest; flagging every `any` would be massive churn with no
      // correctness payoff, so downgrade rather than mass-cast.
      "@typescript-eslint/no-explicit-any": "off",

      // Empty interfaces / `{}` types and the like are sometimes used as
      // extension points; the type-checked variants add noise without value
      // in a non-type-checked config. Keep the safe parts, relax the rest.
      "@typescript-eslint/no-empty-object-type": "off",

      // `no-useless-assignment` (new in eslint:recommended as of ESLint 9.27+)
      // flags the idiomatic `let x = <default>; try { x = await ... } catch { ... }`
      // pattern used pervasively here for resilient I/O (HTTP body reads,
      // policy/snapshot loads, lock acquisition). The initializer is a
      // deliberate safe default, not dead code — removing it would risk
      // "used before assigned" under strict TS. Disabled to avoid churn on
      // intentional error-handling code.
      "no-useless-assignment": "off",

      // `preserve-caught-error` (new ESLint 10 recommended) wants every rethrow
      // to forward `{ cause: err }`. The codebase intentionally rethrows with
      // curated, message-only errors at provider boundaries; threading `cause`
      // everywhere is broad stylistic churn with no correctness payoff here.
      "preserve-caught-error": "off"
    }
  },
  {
    // Tests legitimately use non-null assertions on fixtures and reach into
    // internals; relax the assertion + empty-function rules there only.
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-function": "off"
    }
  }
);
