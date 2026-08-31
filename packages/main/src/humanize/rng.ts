export interface RandomSource {
  next(): number;
  between(min: number, max: number): number;
  int(min: number, max: number): number;
}

export const createRng = (seedText: string): RandomSource => {
  let seed = 2166136261;
  for (let index = 0; index < seedText.length; index++) {
    seed ^= seedText.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }

  return {
    next() {
      seed += 0x6d2b79f5;
      let value = seed;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    },
    between(min: number, max: number) {
      return min + (max - min) * this.next();
    },
    int(min: number, max: number) {
      return Math.round(this.between(min, max));
    },
  };
};
