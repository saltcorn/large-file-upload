const {
  input,
  button,
  span,
  div,
  text,
  text_attr,
} = require("@saltcorn/markup/tags");
const File = require("@saltcorn/data/models/file");
const { getState } = require("@saltcorn/data/db/state");

const btnStyles = [
  { name: "default", label: "Default selector" },
  { name: "btn btn-primary", label: "Primary button" },
  { name: "btn btn-secondary", label: "Secondary button" },
  { name: "btn btn-success", label: "Success button" },
  { name: "btn btn-danger", label: "Danger button" },
  { name: "btn btn-warning", label: "Warning button" },
  { name: "btn btn-info", label: "Info button" },
];

const buildCustomInput = (attrs, file_name) =>
  button(
    {
      type: "button",
      class: attrs.button_style,
      onclick: `$(this).parent().find('input[type=file]').click()`,
    },
    attrs?.label ? attrs.label : "Choose File"
  ) +
  span(
    { class: "custom-file-label lfu-custom-text ms-2" },
    file_name ? "" : "No file chosen"
  );

const largeFileUpload = {
  description: "Upload a large file via chunked XHR with a progress bar",
  isEdit: true,
  setsFileId: true,

  configFields: async () => {
    const dirs = await File.allDirectories();
    return [
      {
        name: "folder",
        label: "Folder",
        type: "String",
        attributes: { options: dirs.map((d) => d.path_to_serve) },
      },
      {
        name: "max_file_size_mb",
        label: "Max file size (MB)",
        type: "Integer",
        required: true,
        default: 5120,
      },
      {
        name: "chunk_size_mb",
        label: "Chunk size (MB)",
        type: "Integer",
        required: true,
        default: 8,
        attributes: { min: 1, max: 64 },
      },
      {
        name: "allowed_extensions",
        label: "Allowed extensions",
        type: "String",
        sublabel:
          "Comma separated, e.g. zip,mp4,csv. Leave blank to allow any file type.",
      },
      {
        name: "button_style",
        label: "Button Style",
        type: "String",
        attributes: { options: btnStyles },
        required: true,
        default: "default",
      },
      {
        name: "label",
        label: "Button Label",
        type: "String",
        showIf: {
          button_style: btnStyles
            .filter((opt) => opt.name !== "default")
            .map((opt) => opt.name),
        },
      },
    ];
  },

  // Built to survive being duplicated by Saltcorn's "add another row"
  // button: elements are found by class within each widget, not by id,
  // and the upload logic is wired up once globally (see
  // large_file_upload.js) instead of per copy.
  run: (nm, file_name, attrs, cls, reqd, field) => {
    if (getState().getConfig("storage_s3_enabled", false)) {
      return div(
        { class: "alert alert-warning mb-0" },
        "Large file upload is not supported when S3 storage is enabled."
      );
    }
    const id = `input${text_attr(nm)}`;
    const customInput = attrs?.button_style && attrs.button_style !== "default";

    const cfg = {
      startUrl: "/large-file-upload/start",
      chunkUrlBase: "/large-file-upload/chunk",
      finishUrlBase: "/large-file-upload/finish",
      statusUrlBase: "/large-file-upload/status",
      cancelUrlBase: "/large-file-upload/cancel",
      fieldId: field.id,
      folder: attrs?.folder || "/",
      max_file_size_mb: attrs?.max_file_size_mb || 5120,
      chunk_size_mb: attrs?.chunk_size_mb || 8,
      allowed_extensions: attrs?.allowed_extensions || "",
    };

    return div(
      {
        class: "large-file-upload-widget",
        "data-cfg": encodeURIComponent(JSON.stringify(cfg)),
      },
      input({
        type: "hidden",
        name: text_attr(nm),
        id,
        class: "lfu-value-input",
        "data-fieldname": field.form_name,
        value: file_name || "",
      }) +
        input({
          type: "file",
          class: [
            "form-control",
            "lfu-file-input",
            cls,
            customInput && "d-none",
          ],
          disabled: attrs.disabled,
          readonly: attrs.readonly,
          "data-on-cloned": "resetLargeFileUpload(this)",
        }) +
        (customInput ? buildCustomInput(attrs, file_name) : "") +
        div(
          { class: "progress mt-1 d-none lfu-progress", style: "height: 6px;" },
          div({
            class: "progress-bar",
            role: "progressbar",
            style: "width: 0%",
          })
        ) +
        span(
          { class: "large-file-upload-status lfu-status ms-2" },
          file_name ? text(file_name) : ""
        )
    );
  },
};

module.exports = { "Large file upload": largeFileUpload };
