/** Show the document tree, selection and history state. */

export default {
  name: 'status',
  summary: 'Show canvas, layers, selection and history state',
  mutates: false,
  params: {
    'with-selection': { type: 'bool', default: false, desc: 'include selection bounds/coverage' },
    layer: { type: 'string', desc: 'focus a single layer' },
  },
  async run(ctx, args) {
    const session = ctx.session;
    const out = session.summary();
    if (args['with-selection']) {
      const stats = await session.selectionStats();
      out.selectionStats = stats;
    }
    if (args.layer) {
      const { findLayer } = await import('../../core/document.js');
      const node = findLayer(session.doc, args.layer);
      out.focus = { ...node.layer, parentId: node.parent?.id ?? null, index: node.index };
    }
    return out;
  },
};
