/**
 * A small Molang compiler for Bedrock-format animation channels (the format
 * Blockbench and Cobblemon-style resource packs use), e.g.
 *   "math.sin(q.anim_time * 90) * 5"
 *   "v.a = q.anim_time * 2; return math.cos(v.a * 57.3) * 3;"
 * Supports numbers, + - * / %, comparisons, && || !, ?:, parentheses,
 * variables (v./variable.), queries (q./query.), temps (t./temp.) and
 * math.* functions (trigonometry in degrees, like Bedrock). Unknown queries
 * read as 0. Expressions are compiled once into closures.
 */

export interface MolangContext {
  /** Queries by short name (anim_time, life_time, ...). */
  q: Record<string, number>;
  /** Persistent variables of the entity. */
  v: Record<string, number>;
  /** Temporaries (reset per evaluation). */
  t: Record<string, number>;
}

export type MolangFn = (ctx: MolangContext) => number;

type Tok = { k: "num"; v: number } | { k: "id"; v: string } | { k: "op"; v: string } | { k: "end" };

const DEG = Math.PI / 180;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const s = src.toLowerCase();
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }
    if ((c >= "0" && c <= "9") || (c === "." && s[i + 1] >= "0" && s[i + 1] <= "9")) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      if (s[j] === "f") j++;
      out.push({ k: "num", v: parseFloat(s.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[a-z_]/.test(c)) {
      let j = i;
      while (j < s.length && /[a-z0-9_.]/.test(s[j])) j++;
      out.push({ k: "id", v: s.slice(i, j) });
      i = j;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (["&&", "||", "<=", ">=", "==", "!=", "??", "->"].includes(two)) {
      out.push({ k: "op", v: two });
      i += 2;
      continue;
    }
    out.push({ k: "op", v: c });
    i++;
  }
  out.push({ k: "end" });
  return out;
}

const MATH: Record<string, (...a: number[]) => number> = {
  sin: (x) => Math.sin(x * DEG),
  cos: (x) => Math.cos(x * DEG),
  asin: (x) => Math.asin(x) / DEG,
  acos: (x) => Math.acos(x) / DEG,
  atan: (x) => Math.atan(x) / DEG,
  atan2: (y, x) => Math.atan2(y, x) / DEG,
  abs: Math.abs,
  ceil: Math.ceil,
  floor: Math.floor,
  round: Math.round,
  trunc: Math.trunc,
  sqrt: Math.sqrt,
  exp: Math.exp,
  ln: Math.log,
  pow: Math.pow,
  min: Math.min,
  max: Math.max,
  mod: (a, b) => a % b,
  clamp: (x, a, b) => Math.min(b, Math.max(a, x)),
  lerp: (a, b, t) => a + (b - a) * t,
  lerprotate: (a, b, t) => a + ((((b - a) % 360) + 540) % 360 - 180) * t,
  hermite_blend: (t) => 3 * t * t - 2 * t * t * t,
  sign: Math.sign,
  random: (a, b) => a + (b - a) * 0.5,
  random_integer: (a, b) => Math.round((a + b) / 2),
  die_roll: (n, lo, hi) => n * (lo + hi) * 0.5,
  min_angle: (x) => ((((x + 180) % 360) + 360) % 360) - 180,
};

class Parser {
  private i = 0;
  constructor(private readonly toks: Tok[]) {}

  private peek(): Tok {
    return this.toks[this.i];
  }
  private next(): Tok {
    return this.toks[this.i++];
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return t.k === "op" && t.v === v;
  }
  private expect(v: string): void {
    if (!this.isOp(v)) throw new Error(`expected ${v}`);
    this.i++;
  }

  /** statements: expr (; expr)* with `return` and assignments */
  program(): MolangFn {
    const stmts: MolangFn[] = [];
    let ret: MolangFn | null = null;
    while (this.peek().k !== "end") {
      if (this.isOp(";")) {
        this.i++;
        continue;
      }
      const t = this.peek();
      if (t.k === "id" && t.v === "return") {
        this.i++;
        ret = this.ternary();
        break;
      }
      stmts.push(this.statement());
    }
    if (stmts.length === 1 && !ret) return stmts[0];
    const all = stmts;
    const r = ret;
    return (ctx) => {
      let last = 0;
      for (const s of all) last = s(ctx);
      return r ? r(ctx) : last;
    };
  }

  private statement(): MolangFn {
    const t = this.peek();
    if (t.k === "id" && this.toks[this.i + 1]?.k === "op" && (this.toks[this.i + 1] as { v: string }).v === "=") {
      this.i += 2;
      const value = this.ternary();
      const [scope, name] = splitName(t.v);
      if (scope === "v")
        return (ctx) => {
          const x = value(ctx);
          ctx.v[name] = x;
          return x;
        };
      if (scope === "t")
        return (ctx) => {
          const x = value(ctx);
          ctx.t[name] = x;
          return x;
        };
      return value;
    }
    return this.ternary();
  }

  private ternary(): MolangFn {
    const cond = this.or();
    if (this.isOp("?")) {
      this.i++;
      const a = this.ternary();
      if (this.isOp(":")) {
        this.i++;
        const b = this.ternary();
        return (ctx) => (cond(ctx) ? a(ctx) : b(ctx));
      }
      return (ctx) => (cond(ctx) ? a(ctx) : 0);
    }
    if (this.isOp("??")) {
      this.i++;
      const b = this.ternary();
      return (ctx) => cond(ctx) || b(ctx);
    }
    return cond;
  }

  private or(): MolangFn {
    let l = this.and();
    while (this.isOp("||")) {
      this.i++;
      const a = l;
      const b = this.and();
      l = (c) => (a(c) || b(c) ? 1 : 0);
    }
    return l;
  }

  private and(): MolangFn {
    let l = this.cmp();
    while (this.isOp("&&")) {
      this.i++;
      const a = l;
      const b = this.cmp();
      l = (c) => (a(c) && b(c) ? 1 : 0);
    }
    return l;
  }

  private cmp(): MolangFn {
    let l = this.add();
    for (;;) {
      const t = this.peek();
      if (t.k !== "op" || !["<", ">", "<=", ">=", "==", "!="].includes(t.v)) return l;
      this.i++;
      const a = l;
      const b = this.add();
      switch (t.v) {
        case "<":
          l = (c) => (a(c) < b(c) ? 1 : 0);
          break;
        case ">":
          l = (c) => (a(c) > b(c) ? 1 : 0);
          break;
        case "<=":
          l = (c) => (a(c) <= b(c) ? 1 : 0);
          break;
        case ">=":
          l = (c) => (a(c) >= b(c) ? 1 : 0);
          break;
        case "==":
          l = (c) => (a(c) === b(c) ? 1 : 0);
          break;
        default:
          l = (c) => (a(c) !== b(c) ? 1 : 0);
      }
    }
  }

  private add(): MolangFn {
    let l = this.mul();
    for (;;) {
      if (this.isOp("+")) {
        this.i++;
        const a = l;
        const b = this.mul();
        l = (c) => a(c) + b(c);
      } else if (this.isOp("-")) {
        this.i++;
        const a = l;
        const b = this.mul();
        l = (c) => a(c) - b(c);
      } else return l;
    }
  }

  private mul(): MolangFn {
    let l = this.unary();
    for (;;) {
      if (this.isOp("*")) {
        this.i++;
        const a = l;
        const b = this.unary();
        l = (c) => a(c) * b(c);
      } else if (this.isOp("/")) {
        this.i++;
        const a = l;
        const b = this.unary();
        l = (c) => {
          const d = b(c);
          return d === 0 ? 0 : a(c) / d;
        };
      } else if (this.isOp("%")) {
        this.i++;
        const a = l;
        const b = this.unary();
        l = (c) => a(c) % b(c);
      } else return l;
    }
  }

  private unary(): MolangFn {
    if (this.isOp("-")) {
      this.i++;
      const a = this.unary();
      return (c) => -a(c);
    }
    if (this.isOp("+")) {
      this.i++;
      return this.unary();
    }
    if (this.isOp("!")) {
      this.i++;
      const a = this.unary();
      return (c) => (a(c) ? 0 : 1);
    }
    return this.primary();
  }

  private primary(): MolangFn {
    const t = this.next();
    if (t.k === "num") {
      const v = t.v;
      return () => v;
    }
    if (t.k === "op" && t.v === "(") {
      const e = this.ternary();
      this.expect(")");
      return e;
    }
    if (t.k === "id") {
      const name = t.v;
      if (name === "true") return () => 1;
      if (name === "false") return () => 0;
      if (name === "math.pi") return () => Math.PI;
      if (this.isOp("(")) {
        this.i++;
        const args: MolangFn[] = [];
        while (!this.isOp(")")) {
          args.push(this.ternary());
          if (this.isOp(",")) this.i++;
          else break;
        }
        this.expect(")");
        if (name.startsWith("math.")) {
          const f = MATH[name.slice(5)] ?? (() => 0);
          return (c) => f(...args.map((a) => a(c)));
        }
        // Unknown query functions (q.bone_rotation(...), etc.) read as 0
        return () => 0;
      }
      const [scope, short] = splitName(name);
      if (scope === "q") return (c) => c.q[short] ?? 0;
      if (scope === "v") return (c) => c.v[short] ?? 0;
      if (scope === "t") return (c) => c.t[short] ?? 0;
      return () => 0;
    }
    throw new Error("unexpected token");
  }
}

function splitName(name: string): ["q" | "v" | "t" | "other", string] {
  const dot = name.indexOf(".");
  if (dot < 0) return ["other", name];
  const head = name.slice(0, dot);
  const rest = name.slice(dot + 1);
  if (head === "q" || head === "query") return ["q", rest];
  if (head === "v" || head === "variable") return ["v", rest];
  if (head === "t" || head === "temp") return ["t", rest];
  return ["other", name];
}

const cache = new Map<string, MolangFn>();

/** Compiles a Molang expression (cached). Invalid expressions evaluate to 0. */
export function compileMolang(src: string | number): MolangFn {
  if (typeof src === "number") return () => src;
  const key = src.trim();
  let fn = cache.get(key);
  if (fn) return fn;
  if (key === "") fn = () => 0;
  else {
    const n = Number(key);
    if (Number.isFinite(n)) fn = () => n;
    else
      try {
        fn = new Parser(tokenize(key)).program();
      } catch {
        fn = () => 0;
      }
  }
  cache.set(key, fn);
  return fn;
}
