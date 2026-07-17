const fileviews = require("./large_fileview");
const { routes, startCleanupSweep } = require("./upload_routes");

module.exports = {
  sc_plugin_api_version: 1,
  plugin_name: "large-file-upload",
  headers: [
    {
      script: `/plugins/public/large-file-upload@${
        require("./package.json").version
      }/large_file_upload.js`,
    },
  ],
  fileviews,
  routes,
  onLoad: async () => {
    startCleanupSweep();
  },
  ready_for_mobile: false,
};
