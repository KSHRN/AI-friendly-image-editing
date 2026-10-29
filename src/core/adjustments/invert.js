export default {
  name: 'invert',
  label: 'Invert',
  params: {},
  create() {
    return {
      map(r, g, b, out) {
        out[0] = 255 - r;
        out[1] = 255 - g;
        out[2] = 255 - b;
      },
    };
  },
};
