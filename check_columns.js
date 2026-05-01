const db = require('./src/database/connection');
db('plans').columnInfo().then(info => {
    console.log('COLUMNS:', Object.keys(info));
    process.exit(0);
}).catch(err => {
    console.error(err);
    process.exit(1);
});
