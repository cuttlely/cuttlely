import swaggerJSDoc from 'swagger-jsdoc'

const swaggerUiOptions = {
    failOnErrors: true, // Throw when parsing errors
    baseDir: __dirname, // Base directory which we use to locate your JSDOC files
    exposeApiDocs: true,
    definition: {
        openapi: '3.0.3',
        info: {
            title: 'Cuttlely APIs',
            summary: 'Interactive swagger-ui auto-generated API docs from express, based on a swagger.yml file',
            version: '1.0.0',
            description:
                'This module serves auto-generated swagger-ui generated API docs from the Cuttlely server, based on a swagger.yml file. Swagger is available on: http://localhost:6655/api-docs',
            license: {
                name: 'Apache 2.0',
                url: 'https://github.com/cuttlely/cuttlely/blob/main/LICENSE.md'
            },
            contact: {
                name: 'cuttlely',
                url: 'https://github.com/cuttlely/cuttlely/blob/main/SECURITY.md'
            }
        },
        servers: [
            {
                url: 'http://localhost:43117/api/v1',
                description: 'Cuttlely server'
            }
        ]
    },
    apis: [`${process.cwd()}/dist/routes/**/*.js`, `${process.cwd()}/src/yml/swagger.yml`]
}

// https://github.com/swagger-api/swagger-ui/blob/master/docs/usage/configuration.md
const swaggerExplorerOptions = {
    swaggerOptions: {
        validatorUrl: '127.0.0.1'
    },
    explorer: true
}

const swaggerDocs = swaggerJSDoc(swaggerUiOptions)

export { swaggerDocs, swaggerExplorerOptions }
