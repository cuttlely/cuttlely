// Commercial email templates are not part of this tree. gulp is not a build step.

function copyNothing(done: (error?: Error | null) => void) {
    done()
}

exports.default = copyNothing
