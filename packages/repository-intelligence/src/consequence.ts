import type { RepositoryIndex } from "./index";

export function consequenceGraphInput(index: RepositoryIndex) {
  return {
    files: index.files.map((file) => file.path),
    imports: index.edges
      .filter((edge) => index.files.some((file) => file.path === edge.to))
      .map((edge) => ({ from: edge.from, to: edge.to })),
    tests: index.tests.map((test) => ({ path: test.path, targets: test.targets })),
    symbols: index.symbols.map((symbol) => ({ path: symbol.path, name: symbol.name, kind: symbol.kind })),
    routes: index.routes.map((route) => ({ file: route.file, path: route.path, kind: route.kind, methods: route.methods })),
    databaseEntities: index.databaseEntities.map((entity) => ({ file: entity.file, name: entity.name, kind: entity.kind }))
  };
}
