/**
 * 表达式沙箱（F6 · DSL 兜底）
 * ----------------------------------------------------------------
 * 用于极少数「8 种结构化计算方式表达不了」的长尾成本项。
 *
 * 安全设计（这是本模块存在的全部理由）：
 *  - **不使用 eval / new Function / 任何动态代码执行**；
 *  - 自实现递归下降解析器，语法只有：数字、变量、白名单函数、
 *    算术 `+ - * / %`、比较 `== != > >= < <=`、括号、三元 `? :`；
 *  - **变量只能来自传入的白名单 vars**，未知标识符直接报错（拿不到任何全局对象）；
 *  - **函数白名单**：min max round ceil floor abs clamp，加一个审一个；
 *  - 运算步数与递归深度双重上限，防恶意表达式拖死进程；
 *  - 结果必须是有限数字（NaN/Infinity 一律视为失败）；
 *  - 系统开关 `FORMULA_DSL_ENABLED` 默认关闭，未开启时 formula 项直接回退。
 *
 * 一句话：**能不用就不用；要用也只能在笼子里用。**
 */

export type DslResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

/** 运算步数上限（防死循环/超长表达式） */
const MAX_STEPS = 10_000;
/** 递归深度上限（防栈溢出） */
const MAX_DEPTH = 32;

/** 函数白名单：新增函数必须在此登记并补测试 */
const FUNCTIONS: Record<string, { arity: [number, number]; fn: (...a: number[]) => number }> = {
  min: { arity: [1, 8], fn: (...a) => Math.min(...a) },
  max: { arity: [1, 8], fn: (...a) => Math.max(...a) },
  round: { arity: [1, 1], fn: (a) => Math.round(a) },
  ceil: { arity: [1, 1], fn: (a) => Math.ceil(a) },
  floor: { arity: [1, 1], fn: (a) => Math.floor(a) },
  abs: { arity: [1, 1], fn: (a) => Math.abs(a) },
  clamp: { arity: [3, 3], fn: (a, lo, hi) => Math.min(Math.max(a, lo), hi) },
};

type Tok =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string };

const OPERATORS = [
  "==", "!=", ">=", "<=", ">",
  "<", "+", "-", "*", "/", "%",
  "(", ")", ",", "?", ":",
];

function tokenize(src: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i++;
      continue;
    }

    // 数字（含小数，不支持 1e5 之类的科学计数以缩小语法面）
    if ((c >= "0" && c <= "9") || c === ".") {
      let j = i;
      let dots = 0;
      while (j < src.length) {
        const d = src[j];
        if (d >= "0" && d <= "9") j++;
        else if (d === "." && dots === 0) {
          dots++;
          j++;
        } else break;
      }
      const raw = src.slice(i, j);
      const n = Number(raw);
      if (!Number.isFinite(n)) return `非法数字：${raw}`;
      out.push({ t: "num", v: n });
      i = j;
      continue;
    }

    // 标识符：只允许字母/数字/下划线，且不能以数字开头
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j) });
      i = j;
      continue;
    }

    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ t: "op", v: op });
      i += op.length;
      continue;
    }

    return `非法字符：${c}`;
  }
  return out;
}

class Evaluator {
  private toks: Tok[];
  private pos = 0;
  private steps = 0;
  private depth = 0;
  private vars: Record<string, number>;

  constructor(toks: Tok[], vars: Record<string, number>) {
    this.toks = toks;
    this.vars = vars;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private bump(): void {
    this.steps++;
    if (this.steps > MAX_STEPS) throw new Error("表达式超出运算步数上限");
  }

  parse(): number {
    const v = this.expr();
    if (this.pos < this.toks.length) {
      throw new Error(`表达式末尾有多余内容：${JSON.stringify(this.toks[this.pos])}`);
    }
    return v;
  }

  private expr(): number {
    const cond = this.comparison();
    const t = this.peek();
    if (t && t.t === "op" && t.v === "?") {
      this.pos++;
      this.bump();
      if (this.depth >= MAX_DEPTH) throw new Error("表达式嵌套过深");
      this.depth++;
      const a = this.expr();
      this.depth--;
      const colon = this.peek();
      if (!colon || colon.t !== "op" || colon.v !== ":") {
        throw new Error("三元表达式缺少 ':'");
      }
      this.pos++;
      this.depth++;
      const b = this.expr();
      this.depth--;
      return cond !== 0 ? a : b;
    }
    return cond;
  }

  private comparison(): number {
    let left = this.additive();
    for (;;) {
      const t = this.peek();
      if (t && t.t === "op" && ["==", "!=", ">=", "<=", ">", "<"].includes(t.v)) {
        this.pos++;
        this.bump();
        const right = this.additive();
        switch (t.v) {
          case "==":
            left = left === right ? 1 : 0;
            break;
          case "!=":
            left = left !== right ? 1 : 0;
            break;
          case ">=":
            left = left >= right ? 1 : 0;
            break;
          case "<=":
            left = left <= right ? 1 : 0;
            break;
          case ">":
            left = left > right ? 1 : 0;
            break;
          default:
            left = left < right ? 1 : 0;
        }
      } else return left;
    }
  }

  private additive(): number {
    let left = this.multiplicative();
    for (;;) {
      const t = this.peek();
      if (t && t.t === "op" && (t.v === "+" || t.v === "-")) {
        this.pos++;
        this.bump();
        const right = this.multiplicative();
        left = t.v === "+" ? left + right : left - right;
      } else return left;
    }
  }

  private multiplicative(): number {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t && t.t === "op" && (t.v === "*" || t.v === "/" || t.v === "%")) {
        this.pos++;
        this.bump();
        const right = this.unary();
        if (t.v === "*") left = left * right;
        else if (t.v === "/") {
          if (right === 0) throw new Error("除数为 0");
          left = left / right;
        } else {
          if (right === 0) throw new Error("取模除数为 0");
          left = left % right;
        }
      } else return left;
    }
  }

  private unary(): number {
    const t = this.peek();
    if (t && t.t === "op" && (t.v === "-" || t.v === "+")) {
      this.pos++;
      this.bump();
      const v = this.unary();
      return t.v === "-" ? -v : v;
    }
    return this.primary();
  }

  private primary(): number {
    const t = this.peek();
    if (!t) throw new Error("表达式意外结束");

    if (t.t === "num") {
      this.pos++;
      this.bump();
      return t.v;
    }

    if (t.t === "op" && t.v === "(") {
      this.pos++;
      if (this.depth >= MAX_DEPTH) throw new Error("表达式嵌套过深");
      this.depth++;
      const v = this.expr();
      this.depth--;
      const close = this.peek();
      if (!close || close.t !== "op" || close.v !== ")") throw new Error("缺少右括号");
      this.pos++;
      return v;
    }

    if (t.t === "id") {
      this.pos++;
      this.bump();
      const next = this.peek();
      if (next && next.t === "op" && next.v === "(") {
        // 函数调用
        const def = FUNCTIONS[t.v];
        if (!def) throw new Error(`不允许的函数：${t.v}`);
        this.pos++;
        const args: number[] = [];
        const first = this.peek();
        if (first && first.t === "op" && first.v === ")") {
          this.pos++;
        } else {
          for (;;) {
            this.depth++;
            args.push(this.expr());
            this.depth--;
            const sep = this.peek();
            if (sep && sep.t === "op" && sep.v === ",") {
              this.pos++;
              continue;
            }
            if (sep && sep.t === "op" && sep.v === ")") {
              this.pos++;
              break;
            }
            throw new Error("函数参数列表缺少右括号");
          }
        }
        const [lo, hi] = def.arity;
        if (args.length < lo || args.length > hi) {
          throw new Error(`函数 ${t.v} 参数个数应为 ${lo}~${hi}`);
        }
        return def.fn(...args);
      }

      // 变量：只能来自白名单 vars
      if (!(t.v in this.vars)) throw new Error(`不允许的变量：${t.v}`);
      const v = this.vars[t.v];
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw new Error(`变量 ${t.v} 不是有效数字`);
      }
      return v;
    }

    throw new Error(`无法解析：${JSON.stringify(t)}`);
  }
}

/**
 * 在沙箱内求值表达式。
 * @param expr 表达式字符串
 * @param vars 变量白名单（只认这里出现的名字）
 */
export function evalExpression(
  expr: string,
  vars: Record<string, number> = {}
): DslResult {
  if (typeof expr !== "string" || !expr.trim()) {
    return { ok: false, error: "表达式为空" };
  }

  const toks = tokenize(expr);
  if (typeof toks === "string") return { ok: false, error: toks };
  if (!toks.length) return { ok: false, error: "表达式为空" };

  try {
    const value = new Evaluator(toks, vars).parse();
    if (!Number.isFinite(value)) return { ok: false, error: "结果不是有限数字" };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 系统级开关：默认关闭。未显式开启时，formula 类型的成本项一律回退。 */
export function isDslEnabled(): boolean {
  return process.env.FORMULA_DSL_ENABLED === "true";
}
