workspace "GMAT prep" "C4 model for GMAT prep." {

    !identifiers hierarchical

    configuration {
        scope softwaresystem
    }

    properties {
        # Prose lives in the glossary and docs/design.md; ADRs are imported below.
        "structurizr.inspection.model.softwaresystem.documentation" "ignore"
    }

    model {
        !impliedRelationships "com.structurizr.model.CreateImpliedRelationshipsUnlessAnyRelationshipExistsStrategy"

        learner = person "Learner" "Prepares for GMAT Focus through Practice Sets, Mocks, Lessons and a Study Plan, under one or more Profiles."
        curator = person "Curator" "Feeds Books in, decides held Questions and approves Lessons for the whole install."

        completionsApi = softwareSystem "Completions API" "OpenAI-compatible LLM provider that the Curator configures." {
            tags "External"
        }

        gmat = softwareSystem "GMAT prep" "Turns prep Books into a verified Question Bank and runs exam-faithful practice with a learning loop, on one computer." {
            !adrs adr madr

            webApp = container "Web app" "Learner and Curator screens: the exam screen, Debriefs, analytics, the Study Plan and the Review Queue." "React, Vite" {
                tags "Web Browser"
            }
            appServer = container "App server" "Serves the API, owns the Session clock, picks adaptive Questions, scores Responses, keeps analytics current, builds Study Plans and relays Tutor Chat." "Bun, Effect 4"
            jobWorker = container "Job worker" "Runs ingestion, Question generation, Lesson writing and full rebuilds, saving progress after each step." "Bun, Effect 4"
            database = container "Database" "Question Bank, Profiles, Sessions, Responses, derived analytics, Study Plans and the job queue." "SQLite in WAL mode" {
                tags "Database"
            }
            fileStore = container "File store" "Book files keyed by content hash, rendered page images, figure crops and snapshots." "Local folder" {
                tags "Folder"
            }
        }

        gmat -> completionsApi "Sends ingestion, generation, Lesson and Tutor Chat requests to" "HTTPS JSON"

        learner -> gmat.webApp "Takes Mocks, Sectionals and Practice Sets, and follows the Study Plan in" "Browser"
        curator -> gmat.webApp "Adds Books, decides held Questions and approves Lessons in" "Browser"

        gmat.appServer -> gmat.webApp "Serves the static files of" "HTTP"
        gmat.webApp -> gmat.appServer "Submits Responses and reads Sessions, analytics and plans through" "HTTP JSON, Server-Sent Events"
        gmat.appServer -> gmat.database "Reads and writes Sessions, Responses, analytics, plans and jobs in" "bun:sqlite"
        gmat.appServer -> gmat.fileStore "Stores incoming Books and snapshots in" "File system"
        gmat.appServer -> gmat.jobWorker "Starts and restarts" "Child process"
        gmat.appServer -> completionsApi "Sends Tutor Chat messages to" "HTTPS JSON"
        gmat.jobWorker -> gmat.database "Claims jobs from and writes Questions, Lessons and rebuilt analytics to" "bun:sqlite"
        gmat.jobWorker -> gmat.fileStore "Reads Books from and writes page images and figure crops to" "File system"
        gmat.jobWorker -> completionsApi "Sends every LLM task except Tutor Chat (ingestion, generation, Lesson writing) to" "HTTPS JSON"

        production = deploymentEnvironment "Production" {
            deploymentNode "Learner's computer" "The one machine the install runs on." "macOS, Linux or Windows" {
                deploymentNode "GMAT prep executable" "One file built with bun build --compile; runs as two processes." "Bun" {
                    containerInstance gmat.appServer
                    containerInstance gmat.jobWorker
                }
                deploymentNode "Data folder" "The OS app-data folder by default; the location can be changed." "File system" {
                    containerInstance gmat.database
                    containerInstance gmat.fileStore
                }
                deploymentNode "Browser on the computer" "Opens the app at localhost." "Chrome, Edge, Firefox or Safari" {
                    containerInstance gmat.webApp
                }
            }
            deploymentNode "Tablet or phone" "Optional; reaches the app in LAN mode after pairing with a code shown on the host." "iPadOS, Android or similar" {
                deploymentNode "Mobile browser" "Shows the stacked layout on narrow screens." "Safari or Chrome" {
                    containerInstance gmat.webApp
                }
            }
            deploymentNode "LLM provider" "Hosted by whichever provider the Curator configures." "Cloud" {
                softwareSystemInstance completionsApi
            }
        }
    }

    views {
        systemContext gmat "Context" {
            include *
            autoLayout lr
        }

        container gmat "Containers" {
            include *
            autoLayout lr
        }

        deployment gmat production "Deployment-Production" {
            include *
            autoLayout lr
        }

        styles {
            element "Element" {
                color #ffffff
            }
            element "Person" {
                shape Person
                background #08427b
            }
            element "Software System" {
                background #1168bd
            }
            element "External" {
                background #999999
            }
            element "Container" {
                background #438dd5
            }
            element "Database" {
                shape Cylinder
            }
            element "Folder" {
                shape Folder
            }
            element "Web Browser" {
                shape WebBrowser
            }
            element "Deployment Node" {
                color #333333
                stroke #888888
            }
        }
    }
}
