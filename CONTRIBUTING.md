# Contributing

Thank you for helping. Keep changes small and tested.

## Run the checks

From the repo folder:

```sh
claude plugin validate .
claude plugin test .
```

Both must pass before you open a pull request. To see your change live, start Claude Code with `claude --plugin-dir .` in a test project.

## Engine rules

The Claude Code engine refuses a mod that breaks one of these rules:

1. One hooks module per plugin. `hooks/hooks.json` names `./register.tsx` only.
2. One hook per event and matcher. Two `on('turn.start', ...)` in one plugin do not load.
3. Event names are written out. `on(someVariable, ...)` is refused.
4. `$` never leaves `register.tsx`. Pass it only to functions declared in the same file. Pure helpers without `$` go in `hooks/feed.ts`.
5. Every `$.state` key is declared in `types/index.d.ts`.
6. No state writes while drawing. Write from an event, a timer or a button press. A drawing only reads.

## Propose a change

1. Open an issue. Say what you see, what you expected, and your Claude Code version.
2. Agree on the change in the issue.
3. Open a pull request that links the issue. Add or update a test in `tests/` for the behaviour you change.
