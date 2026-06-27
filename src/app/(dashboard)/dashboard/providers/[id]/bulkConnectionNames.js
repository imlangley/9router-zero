export function createBulkConnectionNameAllocator() {
  const usedNames = new Set();
  const nextNameSuffixes = new Map();

  return (explicitName) => {
    const baseName = explicitName || "Key";
    let name = baseName;

    if (!explicitName || usedNames.has(name)) {
      let suffix = nextNameSuffixes.get(baseName) || 1;
      do {
        name = `${baseName} ${suffix}`;
        suffix += 1;
      } while (usedNames.has(name));
      nextNameSuffixes.set(baseName, suffix);
    } else {
      nextNameSuffixes.set(baseName, 2);
    }

    usedNames.add(name);
    return name;
  };
}
