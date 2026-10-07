import type {
  AggregateFunctionNode,
  CommonTableExpressionNode,
  FunctionNode,
  KyselyPlugin,
  OperationNode,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryId,
  QueryResult,
  RawNode,
  ReferenceNode,
  RootOperationNode,
  SelectModifierNode,
  UnknownRow,
  WithNode,
} from 'kysely'
import {
  AliasNode,
  IdentifierNode,
  JoinNode,
  ListNode,
  OperationNodeTransformer,
  SchemableIdentifierNode,
  TableNode,
  UsingNode,
} from 'kysely'

// Kysely's root-node guard is internal; keep this list checked against its public root union.
const ROOT_NODE_KINDS = {
  AlterTableNode: true,
  AlterTypeNode: true,
  CreateIndexNode: true,
  CreateSchemaNode: true,
  CreateTableNode: true,
  CreateTypeNode: true,
  CreateViewNode: true,
  DeleteQueryNode: true,
  DropIndexNode: true,
  DropSchemaNode: true,
  DropTableNode: true,
  DropTypeNode: true,
  DropViewNode: true,
  InsertQueryNode: true,
  MergeQueryNode: true,
  RawNode: true,
  RefreshMaterializedViewNode: true,
  SelectQueryNode: true,
  UpdateQueryNode: true,
} satisfies Record<RootOperationNode['kind'], true>

function isRootOperationNode(node: OperationNode): node is RootOperationNode {
  return Object.hasOwn(ROOT_NODE_KINDS, node.kind)
}

class TablePrefixTransformer extends OperationNodeTransformer {
  #prefix: string
  #tables = new Set<string>()
  #ctes = new Set<string>()
  #aliases = new Set<string>()
  #writeTargets = new Set<IdentifierNode>()
  #writeNames = new Set<string>()
  #prefixedIdentifiers = new WeakSet<IdentifierNode>()

  constructor(prefix: string) {
    super()
    this.#prefix = prefix
  }

  override transformNodeImpl<TNode extends OperationNode>(node: TNode, queryId?: QueryId): TNode {
    if (!isRootOperationNode(node) || (node.kind === 'RawNode' && this.nodeStack.length > 1)) {
      return super.transformNodeImpl(node, queryId)
    }
    return this.#transformScope(node, queryId)
  }

  #transformScope<TNode extends RootOperationNode>(node: TNode, queryId?: QueryId): TNode {
    const previousTables = this.#tables
    const previousCTEs = this.#ctes
    const previousAliases = this.#aliases
    const previousWriteTargets = this.#writeTargets
    const previousWriteNames = this.#writeNames
    this.#tables = new Set(previousTables)
    this.#ctes = new Set(previousCTEs)
    this.#aliases = new Set(previousAliases)
    this.#writeTargets = new Set()
    this.#writeNames = new Set(previousWriteNames)
    try {
      let withNode: WithNode | undefined
      if ('with' in node && node.with) {
        withNode = this.#transformWithScope(node.with, queryId)
      }
      this.#collectTables(node)
      this.#collectWriteTargets(node)
      const transformed = super.transformNodeImpl(
        withNode ? { ...node, with: undefined } : node,
        queryId,
      )
      return withNode ? { ...transformed, with: withNode } : transformed
    } finally {
      // Nested queries inherit visible names without leaking them back into the outer query.
      this.#tables = previousTables
      this.#ctes = previousCTEs
      this.#aliases = previousAliases
      this.#writeTargets = previousWriteTargets
      this.#writeNames = previousWriteNames
    }
  }

  override transformTable(node: TableNode, queryId?: QueryId): TableNode {
    // Revisit plugged subqueries for correlated references, but keep their physical tables.
    // Kysely transformers clone containers but retain immutable identifier leaves.
    if (this.#prefixedIdentifiers.has(node.table.identifier)) return node
    const name = node.table.identifier.name
    if (this.#ctes.has(name) && !this.#writeTargets.has(node.table.identifier)) {
      return super.transformTable(node, queryId)
    }
    return this.#prefixTable(node)
  }

  #prefixTable(node: TableNode): TableNode {
    if (node.table.schema !== undefined || this.#prefixedIdentifiers.has(node.table.identifier))
      return node
    const name = node.table.identifier.name
    const transformed = TableNode.create(`${this.#prefix}_${name}`)
    this.#prefixedIdentifiers.add(transformed.table.identifier)
    return transformed
  }

  override transformReference(node: ReferenceNode, queryId?: QueryId): ReferenceNode {
    return {
      ...node,
      column: this.transformNode(node.column, queryId),
      table:
        node.table &&
        this.#tables.has(node.table.table.identifier.name) &&
        !this.#aliases.has(node.table.table.identifier.name)
          ? this.#writeNames.has(node.table.table.identifier.name)
            ? this.#prefixTable(node.table)
            : this.transformNode(node.table, queryId)
          : node.table,
    }
  }

  override transformSelectModifier(
    node: SelectModifierNode,
    queryId?: QueryId,
  ): SelectModifierNode {
    return {
      ...super.transformSelectModifier({ ...node, of: undefined }, queryId),
      of: node.of?.map((item) => this.#transformTableReference(item, queryId)),
    }
  }

  override transformAggregateFunction(
    node: AggregateFunctionNode,
    queryId?: QueryId,
  ): AggregateFunctionNode {
    return {
      ...super.transformAggregateFunction({ ...node, aggregated: [] }, queryId),
      aggregated: this.#transformTableArgs(node.func, node.aggregated, queryId),
    }
  }

  override transformFunction(node: FunctionNode, queryId?: QueryId): FunctionNode {
    return {
      ...super.transformFunction({ ...node, arguments: [] }, queryId),
      arguments: this.#transformTableArgs(node.func, node.arguments, queryId),
    }
  }

  #transformTableArgs(
    func: string,
    args: ReadonlyArray<OperationNode>,
    queryId?: QueryId,
  ): ReadonlyArray<OperationNode> {
    return func === 'json_agg' || func === 'to_json'
      ? args.map((arg) => this.#transformTableReference(arg, queryId))
      : this.transformNodeList(args, queryId)
  }

  #transformTableReference(node: OperationNode, queryId?: QueryId): OperationNode {
    // Only direct table references can be aliases; raw sql.table() nodes still name physical tables.
    return TableNode.is(node) &&
      node.table.schema === undefined &&
      this.#aliases.has(node.table.identifier.name)
      ? node
      : this.transformNode(node, queryId)
  }

  #collectTables(node: RootOperationNode): void {
    this.#collectRawTables(node)
    if ('name' in node && node.name && SchemableIdentifierNode.is(node.name)) {
      this.#tables.add(node.name.identifier.name)
    }
    if ('from' in node && node.from) {
      for (const table of node.from.froms) this.#collectTableExpression(table)
    }
    if ('into' in node && node.into) this.#collectTableExpression(node.into)
    if ('table' in node && node.table) this.#collectTableExpression(node.table)
    if ('joins' in node && node.joins) {
      for (const join of node.joins) this.#collectTableExpression(join.table)
    }
    if ('using' in node && node.using) {
      this.#collectTableExpression(JoinNode.is(node.using) ? node.using.table : node.using)
    }
  }

  #transformWithScope(node: WithNode, queryId?: QueryId): WithNode {
    // Nonrecursive definitions see preceding CTEs, not their own name or later names.
    if (node.recursive) {
      for (const expression of node.expressions) {
        this.#ctes.add(expression.name.table.table.identifier.name)
      }
    }
    const expressions: Array<CommonTableExpressionNode> = []
    for (const expression of node.expressions) {
      expressions.push({
        ...expression,
        expression:
          expression.expression.kind === 'RawNode'
            ? Object.freeze(this.#transformScope(expression.expression as RawNode, queryId))
            : this.transformNode(expression.expression, queryId),
      })
      this.#ctes.add(expression.name.table.table.identifier.name)
    }
    return { ...node, expressions }
  }

  #collectWriteTargets(node: RootOperationNode): void {
    const collect = (table: OperationNode): void => {
      if (TableNode.is(table)) {
        this.#writeTargets.add(table.table.identifier)
        this.#writeNames.add(table.table.identifier.name)
      } else if (AliasNode.is(table)) {
        collect(table.node)
      } else if (ListNode.is(table)) {
        for (const item of table.items) collect(item)
      }
    }
    if (node.kind === 'InsertQueryNode' || node.kind === 'MergeQueryNode') {
      if (node.into) collect(node.into)
    } else if (node.kind === 'UpdateQueryNode') {
      if (node.table) collect(node.table)
    } else if (node.kind === 'DeleteQueryNode') {
      for (const table of node.from.froms) collect(table)
    }
  }

  #collectRawTables(node: OperationNode): void {
    // Qualifiers are references, not declarations. Nested queries collect their own scope.
    if (node.kind === 'ReferenceNode' || node.kind === 'WithNode') return
    if (node.kind === 'RawNode') {
      for (const parameter of (node as RawNode).parameters) {
        if (AliasNode.is(parameter)) {
          if (!isRootOperationNode(parameter.node) || parameter.node.kind === 'RawNode')
            this.#collectRawTables(parameter.node)
          this.#collectTableExpression(parameter)
          continue
        }
        this.#collectTableExpression(parameter)
        if (!isRootOperationNode(parameter) || parameter.kind === 'RawNode')
          this.#collectRawTables(parameter)
      }
      return
    }
    for (const value of Object.values(node)) {
      for (const child of Array.isArray(value) ? value : [value]) {
        if (child && typeof child === 'object' && 'kind' in child) {
          const operation = child as OperationNode
          if (!isRootOperationNode(operation) || operation.kind === 'RawNode')
            this.#collectRawTables(operation)
        }
      }
    }
  }

  #collectTableExpression(node: OperationNode): void {
    if (TableNode.is(node)) {
      this.#tables.add(node.table.identifier.name)
      this.#aliases.delete(node.table.identifier.name)
      // Local read bindings shadow enclosing write qualifiers in correlated subqueries.
      this.#writeNames.delete(node.table.identifier.name)
    } else if (AliasNode.is(node)) {
      if (TableNode.is(node.node)) this.#tables.add(node.node.table.identifier.name)
      if (IdentifierNode.is(node.alias)) this.#aliases.add(node.alias.name)
    } else if (ListNode.is(node)) {
      for (const table of node.items) this.#collectTableExpression(table)
    } else if (UsingNode.is(node)) {
      for (const table of node.tables) this.#collectTableExpression(table)
    }
  }
}

export class TablePrefixPlugin implements KyselyPlugin {
  #transformer: TablePrefixTransformer

  constructor(prefix: string) {
    this.#transformer = new TablePrefixTransformer(prefix)
  }

  transformQuery({ node, queryId }: PluginTransformQueryArgs): RootOperationNode {
    return this.#transformer.transformNode(node, queryId)
  }

  async transformResult({ result }: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return result
  }
}
