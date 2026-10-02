import type { ContentDB } from "../data/contentDb";
import type { SpeciesDef } from "../types/content";

/** The species schema every Pokémon in content/pokemon/species follows. */
export type PokemonSpecies = SpeciesDef;
export type PokemonType = string;

/**
 * Read-only view of the Pokémon species in a content pack: lookup by id or
 * National Dex number, Dex order, and type queries. Game rules (server and
 * client) use this; model files are resolved separately by the client's
 * PokemonAssetRegistry.
 */
export class PokemonSpeciesRegistry {
  private readonly byDex = new Map<number, PokemonSpecies>();
  private readonly ordered: PokemonSpecies[];

  constructor(private readonly db: ContentDB) {
    this.ordered = [...db.species.values()].sort((a, b) => a.dexNumber - b.dexNumber);
    for (const s of this.ordered) this.byDex.set(s.dexNumber, s);
  }

  get size(): number {
    return this.ordered.length;
  }

  get(id: string): PokemonSpecies | undefined {
    return this.db.species.get(id);
  }

  require(id: string): PokemonSpecies {
    const s = this.db.species.get(id);
    if (!s) throw new Error(`unknown Pokémon species ${id}`);
    return s;
  }

  dex(n: number): PokemonSpecies | undefined {
    return this.byDex.get(n);
  }

  /** All species in National Dex order. */
  all(): readonly PokemonSpecies[] {
    return this.ordered;
  }

  ofType(type: PokemonType): PokemonSpecies[] {
    return this.ordered.filter((s) => s.types.includes(type));
  }

  /** "#025 Pikachu" */
  label(id: string): string {
    const s = this.get(id);
    return s ? `#${String(s.dexNumber).padStart(3, "0")} ${s.name}` : id;
  }
}
