/** Save the working document (mutations autosave, this is for clarity). */

export default {
  name: 'save',
  summary: 'Persist the working document to disk',
  mutates: false,
  params: {},
  async run(ctx) {
    await ctx.session.save();
    return { saved: true, project: ctx.projectPath };
  },
};
