import { z } from "zod";
import type * as M from "./model.ts";
import { EDGE_TYPES, LANES, NODE_KINDS } from "./model.ts";

/**
 * The parsing boundary, and only that. The domain itself lives in model.ts with
 * no dependencies, so the browser can have the shapes and the structural checks
 * without also shipping a parser it has no untrusted input for.
 *
 * Each schema is annotated with its model type rather than inferred into one.
 * That is the point: if a field is added to the interface and not to the schema
 * (or vice versa) this file stops compiling, so the two cannot drift.
 */

export const NodeKind = z.enum(NODE_KINDS as [M.NodeKind, ...M.NodeKind[]]);
export const Lane = z.enum(LANES as [M.Lane, ...M.Lane[]]);
export const EdgeType = z.enum(EDGE_TYPES as [M.EdgeType, ...M.EdgeType[]]);

export const Pin: z.ZodType<M.Pin> = z.object({ x: z.number(), y: z.number() });

export const GraphNode: z.ZodType<M.GraphNode, unknown> = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  kind: NodeKind,
  lane: Lane,
  done: z.boolean().default(false),
  note: z.string().default(""),
  wiki: z.string().default(""),
  verify: z.boolean().default(false),
  pin: Pin.nullable().default(null),
});

export const GraphEdge: z.ZodType<M.GraphEdge, unknown> = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  type: EdgeType,
  note: z.string().default(""),
  verify: z.boolean().default(false),
});

export const Graph: z.ZodType<M.Graph, unknown> = z.object({
  version: z.literal(1),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
});

// Aliased rather than re-exported: each name is already a const above, and a
// value and a type may share a name only when both are declared here.
export type NodeKind = M.NodeKind;
export type Lane = M.Lane;
export type EdgeType = M.EdgeType;
export type Pin = M.Pin;
export type GraphNode = M.GraphNode;
export type GraphEdge = M.GraphEdge;
export type Graph = M.Graph;

export {
  EDGE_TYPES,
  findCycle,
  isStructural,
  LANES,
  NODE_KINDS,
  STRUCTURAL,
  validateGraph,
} from "./model.ts";
