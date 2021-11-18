//
// Entry point of the application. Gets everything started.
//
import express, { Application, Router, Request, Response } from 'express'
import cors, { CorsOptions } from 'cors'
import cookieParser from 'cookie-parser'
import * as routes from './routes'
import EventStore, { EventStoreType } from './eventstore'
import {
    StreamId,
    EventData,
    Meta,
    EventName,
    EventHandler,
    Event,
    EventBaseType,
    PiiBaseType, PiiFields,
} from './event'

import AdminProcessor from './admin_processor'

const app = express()
app.use(express.json())
app.use(cookieParser())

export { Request, Response, Router }

export interface ShimmieConfig {
    mode?: string
    ServerPort: number
    CORS?: CorsOptions
}

// testing a new naming scheme. Replace IEvent if we like this one better. Easier
// for users to not be confused with their own event types (eg an event sourced system!)
export type ShimmieEvent = Event

export type StackType = {
    setApiVersion: (version: string) => StackType
    getRouter: () => Router
    recordEvent: (
        streamdId: StreamId,
        eventName: EventName,
        eventData: EventData,
        meta: Meta,
        piiFields?: PiiFields
    ) => void
    startup: () => void
    restart: () => void
    shutdown: () => void
    registerModel<T>(name: string, model: T): void
    getModel<T>(name: string): T
    mountProcessor: (
        name: string,
        mountPoint: string,
        router: Router
    ) => StackType
    subscribe: (eventName: EventName, handler: EventHandler) => void
    use: (a: any) => any
}

const startApiListener = (app: Application, port: number) => {
    app.listen(port, () =>
        logInfo(`ShimmieStack API Server listening on ${port}!`)
    )
}

const startup = async (
    config: ShimmieConfig,
    eventBase: EventBaseType,
    eventStore: EventStoreType,
    piiBase?: PiiBaseType
) => {
    try {
        logInfo('ShimmieStack Start up sequence initiated.')
        logInfo('ShimmieStack Environment:', process.env.NODE_ENV)
        logInfo('ShimmieStack Config:', config)

        routes.finaliseRoutes(app)
        logInfo('ShimmieStack: All processors mounted')

        // Get the database started
        await eventBase.init()
        logInfo('ShimmieStack: event database connected.')

        if (piiBase) {
            await piiBase.init()
            logInfo('ShimmieStack: pii database connected.')
        }

        // Process the entire event history on start up and load into memory
        logInfo(
            `ShimmieStack: Starting to replay the entire event stream to rebuild memory models`
        )
        const numEvents = await eventStore.replayAllEvents()
        logInfo(`ShimmieStack: replayed ${numEvents} events`)

        // Start accepting requests from the outside world
        startApiListener(app, config.ServerPort)

        logInfo('ShimmieStack: Start up complete')
    } catch (err) {
        logInfo('ShimmieStack1 Error during start up, aborting (', err, ')')
    }
}

export default function ShimmieStack(
    config: ShimmieConfig,
    eventBase: EventBaseType,
    piiBase?: PiiBaseType 
): StackType {
    if (!eventBase) throw Error('Missing event base parameter to ShimmieStack')

    /** initialise the event store service by giving it an event database (db, memory, file ) */
    const eventStore = EventStore(eventBase, piiBase)

    app.use(cors(config.CORS || {}))

    // Set of loggers and authentication before all user-defined routes
    routes.initRoutes(app)

    // Install the admin API route
    // TODO: work out how to secure this. Need a client role.
    routes.mountApi(
        app,
        'Administration API',
        '/admin',
        AdminProcessor(eventBase)
    )

    let modelStore: { [key: string]: any } = {}

    const funcs: StackType = {
        startup: () => {
            startup(config, eventBase, eventStore)
        },

        restart: () => {
            logInfo('TODO: empty everything and replay results')
        },

        shutdown: () => {
            logInfo('TODO: HOW DO YOU STOP THIS THING!!!!')
        },

        setApiVersion: (version: string) => {
            routes.setApiVersion(version)
            return funcs
        },

        registerModel: (name: string, model: any) => {
            modelStore[name] = model
        },

        getModel: (name: string): any => {
            const model = modelStore[name]
            if (!model) throw new Error('No registered model found: ' + name)
            return modelStore[name]
        },

        mountProcessor: (name: string, mountPoint: string, router: Router) => {
            const url = routes.mountApi(app, name, mountPoint, router)
            logInfo(`>>>> Mounted ${url} with [${name}]`)
            return funcs
        },

        subscribe: (eventName: EventName, handler: EventHandler) => {
            logInfo('ShimmieStack: Registering event handler: ', eventName)
            eventStore.subscribe(eventName, handler)
        },

        recordEvent: (
            streamdId: StreamId,
            eventName: EventName,
            eventData: EventData,
            meta: Meta,
            piiFields?: PiiFields
        ) => eventStore.recordEvent(streamdId, eventName, eventData, meta, piiFields),

        // Make a new Express router
        getRouter: () => express.Router(),

        // provide the client the Exprese use function so they can do whatever they want
        use: (a: any) => app.use(a),
    }

    return funcs
}

/** don't log info messages when we are running tests */
export function logInfo(...args: any[]) {
    if (process.env.JEST_WORKER_ID === undefined) console.log.apply(args)
}
