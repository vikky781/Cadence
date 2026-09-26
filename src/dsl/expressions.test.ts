import fs from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  ExpressionSyntaxError,
  evaluateExpression,
  getReferencedIdentifiers,
  parseAndValidate,
  type ExpressionContext,
} from "./expressions"

function baseContext(overrides: Partial<ExpressionContext> = {}): ExpressionContext {
  return {
    trialIndex: 0,
    lastResponse: null,
    lastRT: null,
    lastCorrect: null,
    blockAccuracy: null,
    variables: {},
    ...overrides,
  }
}

describe("evaluateExpression", () => {
  it("evaluates a comparison expression", () => {
    expect(
      evaluateExpression("trialIndex > 5", [], baseContext({ trialIndex: 10 })),
    ).toBe(true)
    expect(
      evaluateExpression("trialIndex > 5", [], baseContext({ trialIndex: 2 })),
    ).toBe(false)
  })

  it("evaluates arithmetic, including a declared variable", () => {
    expect(
      evaluateExpression("lastRT + 100", [], baseContext({ lastRT: 250 })),
    ).toBe(350)

    expect(
      evaluateExpression(
        "lastRT + penalty",
        ["penalty"],
        baseContext({ lastRT: 250, variables: { penalty: 50 } }),
      ),
    ).toBe(300)
  })

  it("evaluates logical composition", () => {
    expect(
      evaluateExpression(
        "lastCorrect && trialIndex >= 3",
        [],
        baseContext({ lastCorrect: true, trialIndex: 5 }),
      ),
    ).toBe(true)

    expect(
      evaluateExpression(
        "lastCorrect && trialIndex >= 3",
        [],
        baseContext({ lastCorrect: false, trialIndex: 5 }),
      ),
    ).toBe(false)
  })

  it("evaluates string equality", () => {
    expect(
      evaluateExpression(
        'lastResponse == "left"',
        [],
        baseContext({ lastResponse: "left" }),
      ),
    ).toBe(true)

    expect(
      evaluateExpression(
        'lastResponse == "left"',
        [],
        baseContext({ lastResponse: "right" }),
      ),
    ).toBe(false)
  })

  it("evaluates unary negation and not", () => {
    expect(evaluateExpression("-trialIndex", [], baseContext({ trialIndex: 7 }))).toBe(
      -7,
    )
    expect(
      evaluateExpression("!lastCorrect", [], baseContext({ lastCorrect: true })),
    ).toBe(false)
    expect(
      evaluateExpression("!lastCorrect", [], baseContext({ lastCorrect: false })),
    ).toBe(true)
  })

  it("reads a declared variable name from context.variables at evaluation time", () => {
    const result = evaluateExpression(
      "targetColor == \"blue\"",
      ["targetColor"],
      baseContext({ variables: { targetColor: "blue" } }),
    )
    expect(result).toBe(true)
  })
})

describe("parseAndValidate", () => {
  it("rejects an unknown identifier", () => {
    expect(() => parseAndValidate("notARealName > 1", [])).toThrow(
      ExpressionSyntaxError,
    )
  })

  it("accepts a declared variable name", () => {
    expect(() => parseAndValidate("targetColor", ["targetColor"])).not.toThrow()
  })

  it.each([
    ["function call", "foo()"],
    ["member access", "foo.bar"],
    ["ternary", "trialIndex ? 1 : 2"],
    ["array literal", "[1,2]"],
  ])("rejects %s", (_label, source) => {
    expect(() => parseAndValidate(source, ["foo"])).toThrow(ExpressionSyntaxError)
  })

  it("rejects malformed syntax", () => {
    expect(() => parseAndValidate("trialIndex >", [])).toThrow(ExpressionSyntaxError)
  })
})

describe("getReferencedIdentifiers", () => {
  it("returns distinct identifiers in first-appearance order", () => {
    expect(
      getReferencedIdentifiers("trialIndex + lastRT - trialIndex + targetColor"),
    ).toEqual(["trialIndex", "lastRT", "targetColor"])
  })
})

describe("safety constraint", () => {
  it("does not use eval() or new Function anywhere in its own source", () => {
    const selfPath = path.join(process.cwd(), "src/dsl/expressions.ts")
    const source = fs.readFileSync(selfPath, "utf-8")

    expect(source).not.toContain("eval(")
    expect(source).not.toContain("new Function")
  })
})
