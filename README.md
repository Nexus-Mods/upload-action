# NexusMods Upload GitHub Action

This GitHub Action uploads a file to NexusMods using the NexusMods v3 API. It is designed to automate the process of uploading mod files as part of your CI/CD workflow.

## Features

- Uploads a file to NexusMods

## Inputs

| Name                         | Description                                                                      | Required | Default  |
| ---------------------------- | -------------------------------------------------------------------------------- | -------- | -------- |
| api_key                      | [API key](https://www.nexusmods.com/settings/api-keys)                           | Yes      |          |
| file_group_id                | Group ID of the file (See [How to find the group ID](#how-to-find-the-group-id)) | Yes      |          |
| filename                     | Name of the zip file to upload                                                   | Yes      |          |
| version                      | Version string for the uploaded file (e.g., 1.0.0)                               | Yes      |          |
| display_name                 | Display name for the uploaded file                                               | No       | filename |
| description                  | Description for the uploaded file                                                | No       |          |
| file_category                | File category for the uploaded file                                              | No       | main     |
| archive_existing_file        | Archive the existing file when uploading a new version                           | No       | false    |
| primary_mod_manager_download | Whether this file is the default download for mod managers                       | No       | false    |
| allow_mod_manager_download   | Whether mod manager downloads are enabled for this file                          | No       | true     |
| show_requirements_pop_up     | Whether to show a requirements popup when downloading this file                  | No       | false    |

## Outputs

| Name     | Description                                |
| -------- | ------------------------------------------ |
| file_uid | The UID of the uploaded file on Nexus Mods |

## Usage

First, use another action to create a zip file. Then, use this action to upload the zip file to NexusMods:

## Example

```yaml
- name: Zip files
  run: zip -r my-mod.zip ./dist

- name: Upload to NexusMods
  uses: Nexus-Mods/upload-action@<tag>
  with:
    api_key: ${{ secrets.NEXUSMODS_API_KEY }}
    file_group_id: <file_group_id>
    filename: my-mod.zip
    version: 1.0.0
    file_category: main # optional
```

## How to find the group ID

To get a group ID to use in this action, you need to have created a mod page on Nexus Mods and uploaded at least one file. The group ID can be found by checking the "API Info" option in [the Files tab of the public-facing mod page](https://staticdelivery.nexusmods.com/mods/2295/images/26/26-1773850631-254743025.png), or in the [edit menu of the Manage Files page](https://staticdelivery.nexusmods.com/mods/2295/images/26/26-1775133874-1209377152.png).

## Development

### Requirements

This project requires Node v20 or higher

### Running locally

First run `npm install`, then create a `.env` file with the following required environment variables:

- `INPUT_API_KEY`
- `INPUT_FILE_GROUP_ID`
- `INPUT_FILENAME`
- `INPUT_VERSION`

Optional environment variables:

- `INPUT_DISPLAY_NAME`
- `INPUT_DESCRIPTION`
- `INPUT_FILE_CATEGORY`
- `INPUT_ARCHIVE_EXISTING_FILE`
- `INPUT_PRIMARY_MOD_MANAGER_DOWNLOAD`
- `INPUT_ALLOW_MOD_MANAGER_DOWNLOAD`
- `INPUT_SHOW_REQUIREMENTS_POP_UP`
- `NEXUSMODS_API_BASE` - Override the API base URL (defaults to `https://api.nexusmods.com/v3`)
- `ACTIONS_STEP_DEBUG=true` - Enable debug output

Then run `npm run local-action` to build and run the action locally.

Before committing you must build the project with `npm run build`.

### OpenAPI schema

This is generated using openapi-typescript via the following command:

`npm run openapi-spec`

### Building

Run the following command to compile the TypeScript source and bundle it into `dist/index.js`:

```bash
npm run build
```

This uses Rollup with the TypeScript plugin to produce a single minified ES module bundle. The `dist/` directory must be committed, as GitHub Actions runs the bundled output directly.

## License

MIT
