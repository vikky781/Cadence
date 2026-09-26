import jsep from "jsep"

export class ExpressionSyntaxError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExpressionSyntaxError"
  }
}

export class ExpressionEvaluationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ExpressionEvaluationError"
  }
}

export interface ExpressionContext {
  trialIndex: number
  lastResponse: string | null
  lastRT: number | null
  lastCorrect: boolean | null
  blockAccuracy: number | null
  variables: Record<string, number | string | boolean>
}

const BUILT_IN_NAMES = new Set([
  "trialIndex",
  "lastResponse",
  "lastRT",
  "lastCorrect",
  "blockAccuracy",
])

const ALLOWED_BINARY_OPERATORS = new Set([
  "==",
  "!=",
  "===",
  "!==",
  "<",
  "<=",
  ">",
  ">=",
  "+",
  "-",
  "*",
  "/",
  "%",
  "&&",
  "||",
])

const ALLOWED_UNARY_OPERATORS = new Set(["!", "-"])

type AnyRecord = Record<string, unknown>

function isExpressionNode(value: unknown): value is jsep.Expression {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as AnyRecord).type === "string"
  )
}

function forEachChild(
  node: jsep.Expression,
  visit: (child: jsep.Expression) => void,
): void {
  for (const key of Object.keys(node)) {
    if (key === "type") continue
    const value = (node as AnyRecord)[key]
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isExpressionNode(item)) visit(item)
      }
    } else if (isExpressionNode(value)) {
      visit(value)
    }
  }
}

function walk(node: jsep.Expression, visit: (node: jsep.Expression) => void): void {
  visit(node)
  forEachChild(node, (child) => walk(child, visit))
}

function parseSource(source: string): jsep.Expression {
  try {
    return jsep(source)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ExpressionSyntaxError(
      `Failed to parse expression "${source}": ${reason}`,
    )
  }
}

export function parseAndValidate(
  source: string,
  declaredVariableNames: string[],
): jsep.Expression {
  const ast = parseSource(source)
  const declared = new Set(declaredVariableNames)

  walk(ast, (node) => {
    switch (node.type) {
      case "Literal":
        return

      case "Identifier": {
        const name = (node as jsep.Identifier).name
        if (!BUILT_IN_NAMES.has(name) && !declared.has(name)) {
          throw new ExpressionSyntaxError(
            `Unknown identifier "${name}" in expression "${source}"`,
          )
        }
        return
      }

      case "UnaryExpression": {
        const operator = (node as jsep.UnaryExpression).operator
        if (!ALLOWED_UNARY_OPERATORS.has(operator)) {
          throw new ExpressionSyntaxError(
            `Disallowed unary operator "${operator}" in expression "${source}"`,
          )
        }
        return
      }

      case "BinaryExpression":
      case "LogicalExpression": {
        const operator = (node as jsep.BinaryExpression).operator
        if (!ALLOWED_BINARY_OPERATORS.has(operator)) {
          throw new ExpressionSyntaxError(
            `Disallowed operator "${operator}" in expression "${source}"`,
          )
        }
        return
      }

      default:
        throw new ExpressionSyntaxError(
          `Disallowed construct "${node.type}" in expression "${source}"`,
        )
    }
  })

  return ast
}

export function getReferencedIdentifiers(source: string): string[] {
  const ast = parseSource(source)

  const seen = new Set<string>()
  const ordered: string[] = []

  walk(ast, (node) => {
    if (node.type === "Identifier") {
      const name = (node as jsep.Identifier).name
      if (!seen.has(name)) {
        seen.add(name)
        ordered.push(name)
      }
    }
  })

  return ordered
}

function resolveIdentifier(
  name: string,
  context: ExpressionContext,
  source: string,
): number | string | boolean | null {
  switch (name) {
    case "trialIndex":
      return context.trialIndex
    case "lastResponse":
      return context.lastResponse
    case "lastRT":
      return context.lastRT
    case "lastCorrect":
      return context.lastCorrect
    case "blockAccuracy":
      return context.blockAccuracy
    default:
      if (Object.prototype.hasOwnProperty.call(context.variables, name)) {
        return context.variables[name]
      }
      throw new ExpressionEvaluationError(
        `No value available for identifier "${name}" in expression "${source}"`,
      )
  }
}

function evaluateNode(
  node: jsep.Expression,
  context: ExpressionContext,
  source: string,
): number | string | boolean | null {
  switch (node.type) {
    case "Literal":
      return (node as jsep.Literal).value as number | string | boolean | null

    case "Identifier":
      return resolveIdentifier((node as jsep.Identifier).name, context, source)

    case "UnaryExpression": {
      const unary = node as jsep.UnaryExpression
      const value = evaluateNode(unary.argument, context, source)
      switch (unary.operator) {
        case "!":
          return !value
        case "-":
          return -Number(value)
        default:
          throw new ExpressionEvaluationError(
            `Unsupported unary operator "${unary.operator}" in expression "${source}"`,
          )
      }
    }

    case "BinaryExpression":
    case "LogicalExpression":
      return evaluateBinary(node as jsep.BinaryExpression, context, source)

    default:
      throw new ExpressionEvaluationError(
        `Unsupported node type "${node.type}" in expression "${source}"`,
      )
  }
}

function evaluateBinary(
  node: jsep.BinaryExpression,
  context: ExpressionContext,
  source: string,
): number | string | boolean | null {
  const { operator } = node

  if (operator === "&&") {
    const left = evaluateNode(node.left, context, source)
    return left ? evaluateNode(node.right, context, source) : left
  }
  if (operator === "||") {
    const left = evaluateNode(node.left, context, source)
    return left ? left : evaluateNode(node.right, context, source)
  }

  const left = evaluateNode(node.left, context, source) as never
  const right = evaluateNode(node.right, context, source) as never

  switch (operator) {
    case "==":
      return left == right
    case "!=":
      return left != right
    case "===":
      return left === right
    case "!==":
      return left !== right
    case "<":
      return left < right
    case "<=":
      return left <= right
    case ">":
      return left > right
    case ">=":
      return left >= right
    case "+":
      return left + right
    case "-":
      return left - right
    case "*":
      return left * right
    case "/":
      return left / right
    case "%":
      return left % right
    default:
      throw new ExpressionEvaluationError(
        `Unsupported operator "${operator}" in expression "${source}"`,
      )
  }
}

export function evaluateExpression(
  source: string,
  declaredVariableNames: string[],
  context: ExpressionContext,
): number | string | boolean {
  const ast = parseAndValidate(source, declaredVariableNames)
  return evaluateNode(ast, context, source) as number | string | boolean
}
