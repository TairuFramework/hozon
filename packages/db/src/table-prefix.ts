import type {
  AggregateFunctionNode,
  FunctionNode,
  KyselyPlugin,
  OperationNode,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryId,
  QueryResult,
  ReferenceNode,
  RootOperationNode,
  SelectModifierNode,
  UnknownRow,
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
  #prefixedTables = new WeakSet<TableNode>()

  constructor(prefix: string) {
    super()
    this.#prefix = prefix
  }

  override transformNodeImpl<TNode extends OperationNode>(node: TNode, queryId?: QueryId): TNode {
    if (!isRootOperationNode(node)) {
      return super.transformNodeImpl(node, queryId)
    }

    const previousTables = this.#tables
    const previousCTEs = this.#ctes
    const previousAliases = this.#aliases
    this.#tables = new Set(previousTables)
    this.#ctes = new Set(previousCTEs)
    this.#aliases = new Set(previousAliases)
    try {
      if ('with' in node && node.with) {
        for (const expression of node.with.expressions) {
          this.#ctes.add(expression.name.table.table.identifier.name)
        }
      }
      this.#collectTables(node)
      return super.transformNodeImpl(node, queryId)
    } finally {
      // Nested queries inherit visible names without leaking them back into the outer query.
      this.#tables = previousTables
      this.#ctes = previousCTEs
      this.#aliases = previousAliases
    }
  }

  override transformTable(node: TableNode, queryId?: QueryId): TableNode {
    // Revisit plugged subqueries for correlated references, but keep their physical tables.
    if (this.#prefixedTables.has(node)) return node
    const name = node.table.identifier.name
    if (node.table.schema !== undefined || this.#ctes.has(name)) {
      return super.transformTable(node, queryId)
    }
    const transformed = TableNode.create(`${this.#prefix}_${name}`)
    this.#prefixedTables.add(transformed)
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
          ? this.transformNode(node.table, queryId)
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

  #collectTableExpression(node: OperationNode): void {
    if (TableNode.is(node)) {
      this.#tables.add(node.table.identifier.name)
      this.#aliases.delete(node.table.identifier.name)
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
