import { ExpressionSyntaxError, parseAndValidate } from "./expressions"
import type { Experiment, Node } from "./types"

export type LintSeverity = "error" | "warning" | "info"

export interface LintIssue {
  rule: string
  severity: LintSeverity
  message: string
  nodeId?: string
}

export interface LintResult {
  valid: boolean
  errors: LintIssue[]
  warnings: LintIssue[]
  infos: LintIssue[]
}

const FRAME_MS = 1000 / 60
const RESERVED_KEYS = new Set(["escape", "f5", "tab", "control", "meta", "alt"])

function getOutgoingEdges(node: Node): string[] {
  switch (node.type) {
    case "consent":
      return [node.next, node.declineNodeId]
    case "instructions":
      return [node.next]
    case "trial":
      return [node.next]
    case "block":
      return [node.next, node.trialTemplate]
    case "branch":
      return [node.onTrue, node.onFalse]
    case "randomizer":
      return node.arms.map((arm) => arm.next)
    case "survey":
      return [node.next]
    case "break":
      return [node.next]
    case "end":
      return []
  }
}

function computeReachable(entry: string, edges: Map<string, string[]>): Set<string> {
  const visited = new Set<string>()
  const stack = [entry]

  while (stack.length > 0) {
    const current = stack.pop() as string
    if (visited.has(current)) continue
    visited.add(current)
    for (const next of edges.get(current) ?? []) {
      if (!visited.has(next)) stack.push(next)
    }
  }

  return visited
}

function detectCycle(nodeIds: string[], edges: Map<string, string[]>): string | null {
  const state = new Map<string, "visiting" | "visited">()

  function visit(nodeId: string): string | null {
    state.set(nodeId, "visiting")
    for (const next of edges.get(nodeId) ?? []) {
      const nextState = state.get(next)
      if (nextState === "visiting") return next
      if (nextState !== "visited") {
        const found = visit(next)
        if (found) return found
      }
    }
    state.set(nodeId, "visited")
    return null
  }

  for (const nodeId of nodeIds) {
    if (!state.has(nodeId)) {
      const found = visit(nodeId)
      if (found) return found
    }
  }

  return null
}

export function lintExperiment(experiment: Experiment): LintResult {
  const issues: LintIssue[] = []
  const nodes = experiment.nodes
  const nodeIds = Object.keys(nodes)

  const edges = new Map<string, string[]>()
  for (const nodeId of nodeIds) {
    edges.set(nodeId, getOutgoingEdges(nodes[nodeId]))
  }

  const reachable = computeReachable(experiment.entry, edges)

  for (const nodeId of nodeIds) {
    if (!reachable.has(nodeId)) {
      issues.push({
        rule: "unreachable-node",
        severity: "error",
        message: `Node "${nodeId}" is not reachable from entry "${experiment.entry}".`,
        nodeId,
      })
    }
  }

  const hasReachableEnd = [...reachable].some((nodeId) => nodes[nodeId]?.type === "end")
  if (!hasReachableEnd) {
    issues.push({
      rule: "no-reachable-end",
      severity: "error",
      message: "No node of type \"end\" is reachable from the entry node.",
    })
  }

  const cycleNodeId = detectCycle(nodeIds, edges)
  if (cycleNodeId) {
    issues.push({
      rule: "cycle-detected",
      severity: "error",
      message: `Cycle detected: node "${cycleNodeId}" is revisited while still on the traversal path.`,
      nodeId: cycleNodeId,
    })
  }

  const assetIds = new Set(experiment.assets.map((asset) => asset.id))
  for (const node of Object.values(nodes)) {
    if (node.type !== "trial") continue
    for (const phase of node.phases) {
      if (phase.content?.kind === "asset" && !assetIds.has(phase.content.value)) {
        issues.push({
          rule: "missing-asset",
          severity: "error",
          message: `Trial "${node.id}" references missing asset "${phase.content.value}".`,
          nodeId: node.id,
        })
      }
    }
  }

  for (const node of Object.values(nodes)) {
    if (node.type !== "block") continue
    const template = nodes[node.trialTemplate]
    if (!template || template.type !== "trial") continue

    const reportedColumns = new Set<string>()
    for (const phase of template.phases) {
      if (phase.content?.kind !== "column") continue
      const columnName = phase.content.value
      if (reportedColumns.has(columnName)) continue

      const presentInEveryRow = node.rows.every((row) =>
        Object.prototype.hasOwnProperty.call(row, columnName),
      )
      if (!presentInEveryRow) {
        reportedColumns.add(columnName)
        issues.push({
          rule: "missing-column",
          severity: "error",
          message: `Block "${node.id}" is missing column "${columnName}" (required by its trial template) in at least one row.`,
          nodeId: node.id,
        })
      }
    }
  }

  const declaredVariableNames = experiment.variables.map((variable) => variable.name)
  const checkExpression = (source: string, nodeId: string) => {
    try {
      parseAndValidate(source, declaredVariableNames)
    } catch (error) {
      if (error instanceof ExpressionSyntaxError) {
        issues.push({
          rule: "invalid-expression",
          severity: "error",
          message: error.message,
          nodeId,
        })
      } else {
        throw error
      }
    }
  }

  for (const node of Object.values(nodes)) {
    if (node.type === "branch") {
      checkExpression(node.condition, node.id)
    } else if (node.type === "trial" && node.response?.correctAnswer !== undefined) {
      checkExpression(node.response.correctAnswer, node.id)
    }
  }

  for (const node of Object.values(nodes)) {
    if (node.type !== "trial" || !node.response) continue
    const { allowedKeys, timeoutMs } = node.response

    if (allowedKeys.length === 0 && !(timeoutMs > 0)) {
      issues.push({
        rule: "hanging-response",
        severity: "error",
        message: `Trial "${node.id}" has no allowed keys and a non-positive timeout, so its response can never end.`,
        nodeId: node.id,
      })
    }

    for (const key of allowedKeys) {
      if (RESERVED_KEYS.has(key.toLowerCase())) {
        issues.push({
          rule: "reserved-response-key",
          severity: "error",
          message: `Trial "${node.id}" allows reserved key "${key}" as a response key.`,
          nodeId: node.id,
        })
      }
    }
  }

  for (const node of Object.values(nodes)) {
    if (node.type !== "trial") continue
    for (const phase of node.phases) {
      if (typeof phase.duration !== "number") continue

      const nearestFrames = Math.round(phase.duration / FRAME_MS)
      const nearestValue = nearestFrames * FRAME_MS
      if (Math.abs(phase.duration - nearestValue) > 0.1 * FRAME_MS) {
        issues.push({
          rule: "non-frame-duration",
          severity: "warning",
          message: `Trial "${node.id}" has a phase duration of ${phase.duration}ms, which is not frame-aligned; nearest frame-aligned value is ${nearestValue.toFixed(2)}ms.`,
          nodeId: node.id,
        })
      }

      if (phase.type === "stimulus" && phase.duration < 2 * FRAME_MS) {
        issues.push({
          rule: "very-short-stimulus",
          severity: "warning",
          message: `Trial "${node.id}" has a stimulus phase duration of ${phase.duration}ms, shorter than two display frames (~${(2 * FRAME_MS).toFixed(2)}ms).`,
          nodeId: node.id,
        })
      }
    }
  }

  for (const node of Object.values(nodes)) {
    if (node.type !== "block" || !node.orderColumn) continue

    const counts = new Map<string | number, number>()
    for (const row of node.rows) {
      const value = row[node.orderColumn]
      counts.set(value, (counts.get(value) ?? 0) + 1)
    }

    if (counts.size >= 2) {
      const values = [...counts.values()]
      const max = Math.max(...values)
      const min = Math.min(...values)
      if (min > 0 && max / min > 1.5) {
        issues.push({
          rule: "unequal-condition-counts",
          severity: "warning",
          message: `Block "${node.id}" has unequal counts for column "${node.orderColumn}" (max ${max}, min ${min}, ratio ${(max / min).toFixed(2)}).`,
          nodeId: node.id,
        })
      }
    }
  }

  for (const asset of experiment.assets) {
    if (asset.kind !== "image") continue

    const exceeded: string[] = []
    if (asset.bytes > 2_097_152) {
      exceeded.push(`bytes (${asset.bytes} > 2097152)`)
    }
    if (asset.width !== undefined && asset.width > 3840) {
      exceeded.push(`width (${asset.width} > 3840)`)
    }
    if (asset.height !== undefined && asset.height > 3840) {
      exceeded.push(`height (${asset.height} > 3840)`)
    }

    if (exceeded.length > 0) {
      issues.push({
        rule: "oversized-image-asset",
        severity: "warning",
        message: `Asset "${asset.id}" exceeds threshold(s): ${exceeded.join(", ")}.`,
      })
    }
  }

  if (experiment.meta.estimatedMinutes > 30) {
    issues.push({
      rule: "long-duration-estimate",
      severity: "warning",
      message: `Estimated duration ${experiment.meta.estimatedMinutes} minutes exceeds the 30-minute guideline.`,
    })
  }

  for (const node of Object.values(nodes)) {
    if (node.type !== "randomizer") continue
    const distinctWeights = new Set(node.arms.map((arm) => arm.weight))
    if (distinctWeights.size > 1) {
      issues.push({
        rule: "unequal-randomizer-weights",
        severity: "info",
        message: `Randomizer "${node.id}" has arms with unequal weights.`,
        nodeId: node.id,
      })
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error")
  const warnings = issues.filter((issue) => issue.severity === "warning")
  const infos = issues.filter((issue) => issue.severity === "info")

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    infos,
  }
}
