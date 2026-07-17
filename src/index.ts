import 'dotenv/config'
import { startScheduler } from './scheduler.js'
import { startServer } from './server.js'

startScheduler()
startServer()
