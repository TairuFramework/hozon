const { withHozonMetroConfig } = require('@hozon/expo/metro')
const { getDefaultConfig } = require('expo/metro-config')

module.exports = withHozonMetroConfig(getDefaultConfig(__dirname))
