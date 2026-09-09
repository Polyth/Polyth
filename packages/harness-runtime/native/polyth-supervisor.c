#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <linux/prctl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t stopping = 0;

static void request_stop(int signal_number) {
    (void)signal_number;
    stopping = 1;
}

static int install_signal_handlers(void) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = request_stop;
    sigemptyset(&action.sa_mask);
    return sigaction(SIGTERM, &action, NULL)
        || sigaction(SIGINT, &action, NULL)
        || sigaction(SIGHUP, &action, NULL);
}

static int write_all(int fd, const char *value, size_t length) {
    size_t written = 0;
    while (written < length) {
        ssize_t result = write(fd, value + written, length - written);
        if (result < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        written += (size_t)result;
    }
    return 0;
}

static int write_receipt(const char *path, const char *proof) {
    size_t template_length = strlen(path) + sizeof(".tmp.XXXXXX");
    char *temporary = malloc(template_length);
    if (!temporary) return -1;
    if (snprintf(temporary, template_length, "%s.tmp.XXXXXX", path) < 0) {
        free(temporary);
        return -1;
    }
    int fd = mkstemp(temporary);
    if (fd < 0) {
        free(temporary);
        return -1;
    }
    int failed = fchmod(fd, 0600)
        || write_all(fd, proof, strlen(proof))
        || fsync(fd)
        || close(fd)
        || rename(temporary, path);
    if (failed) {
        int saved_errno = errno;
        close(fd);
        unlink(temporary);
        errno = saved_errno;
    }
    free(temporary);
    return failed ? -1 : 0;
}

static int wait_for_launch_gate(void) {
    char byte;
    while (!stopping) {
        ssize_t result = read(3, &byte, 1);
        if (result == 1) return byte == 'G' ? 1 : 0;
        if (result == 0) return 0;
        if (errno != EINTR) return 0;
    }
    return 0;
}

static void close_inherited_descriptors(void) {
#ifdef SYS_close_range
    if (syscall(SYS_close_range, 3U, ~0U, 0U) == 0) return;
#endif
    long maximum = sysconf(_SC_OPEN_MAX);
    if (maximum < 0 || maximum > 1048576) maximum = 1048576;
    for (int fd = 3; fd < maximum; fd++) close(fd);
}

static int read_children(pid_t **children, size_t *count) {
    char path[96];
    if (snprintf(path, sizeof(path), "/proc/self/task/%ld/children", (long)getpid()) < 0) return -1;
    FILE *file = fopen(path, "r");
    if (!file) return -1;
    char *line = NULL;
    size_t capacity = 0;
    errno = 0;
    ssize_t length = getline(&line, &capacity, file);
    int read_errno = errno;
    int close_failed = fclose(file);
    if ((length < 0 && read_errno != 0) || close_failed) {
        free(line);
        if (read_errno != 0) errno = read_errno;
        return -1;
    }
    if (length < 0) {
        free(line);
        *count = 0;
        return 0;
    }
    size_t used = 0;
    char *cursor = line;
    while (cursor && *cursor) {
        errno = 0;
        char *end = NULL;
        long value = strtol(cursor, &end, 10);
        if (cursor == end) break;
        if (errno || value <= 0) {
            free(line);
            return -1;
        }
        pid_t *grown = realloc(*children, (used + 1) * sizeof(**children));
        if (!grown) {
            free(line);
            return -1;
        }
        *children = grown;
        (*children)[used++] = (pid_t)value;
        cursor = end;
    }
    free(line);
    *count = used;
    return 0;
}

static int terminate_descendants(void) {
    const struct timespec pause = { .tv_sec = 0, .tv_nsec = 10000000 };
    for (;;) {
        pid_t *children = NULL;
        size_t count = 0;
        if (read_children(&children, &count) != 0) {
            free(children);
            return -1;
        }
        if (count == 0) {
            free(children);
            return 0;
        }
        for (size_t index = 0; index < count; index++) {
            if (kill(children[index], SIGKILL) != 0 && errno != ESRCH) {
                free(children);
                return -1;
            }
        }
        free(children);
        while (waitpid(-1, NULL, WNOHANG) > 0) {}
        nanosleep(&pause, NULL);
    }
}

static int wait_for_child_or_owner(pid_t child, int *status) {
    for (;;) {
        pid_t result = waitpid(child, status, WNOHANG);
        if (result == child) return 1;
        if (result < 0 && errno != EINTR) return -1;
        if (stopping) return 0;
        struct pollfd owner = { .fd = 3, .events = POLLIN | POLLHUP };
        int polled = poll(&owner, 1, 50);
        if (polled < 0) {
            if (errno == EINTR) continue;
            return -1;
        }
        if (polled > 0 && owner.revents) {
            char discarded[64];
            ssize_t bytes = read(3, discarded, sizeof(discarded));
            if (bytes == 0 || (bytes < 0 && errno != EINTR && errno != EAGAIN)) return 0;
        }
    }
}

int main(int argc, char **argv) {
    if (argc < 4) {
        fputs("Polyth runtime supervisor received an invalid launch request\n", stderr);
        return 127;
    }
    if (prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0) {
        fputs("Polyth runtime supervisor could not establish subreaper ownership\n", stderr);
        return 125;
    }
    if (install_signal_handlers() != 0) {
        fputs("Polyth runtime supervisor could not install signal handlers\n", stderr);
        return 124;
    }
    size_t ready_length = strlen(argv[1]) + sizeof(".ready");
    char *ready_path = malloc(ready_length);
    if (!ready_path || snprintf(ready_path, ready_length, "%s.ready", argv[1]) < 0
        || write_receipt(ready_path, argv[2]) != 0) {
        fputs("Polyth runtime supervisor could not create its ready receipt\n", stderr);
        free(ready_path);
        return 123;
    }
    free(ready_path);
    pid_t child = -1;
    int child_status = 0;
    int child_finished = 0;
    if (wait_for_launch_gate()) {
        child = fork();
        if (child == 0) {
            close_inherited_descriptors();
            execvp(argv[3], &argv[3]);
            dprintf(STDERR_FILENO, "Polyth runtime supervisor could not launch %s: %s\n", argv[3], strerror(errno));
            _exit(127);
        }
        if (child < 0) {
            fputs("Polyth runtime supervisor could not fork the harness process\n", stderr);
            stopping = 1;
        }
    } else {
        stopping = 1;
    }
    if (child > 0) {
        child_finished = wait_for_child_or_owner(child, &child_status);
        if (child_finished < 0) stopping = 1;
    }
    if (terminate_descendants() != 0) {
        fputs("Polyth runtime supervisor could not prove descendant cleanup\n", stderr);
        return 120;
    }
    if (write_receipt(argv[1], argv[2]) != 0) {
        fputs("Polyth runtime supervisor could not create its release receipt\n", stderr);
        return 119;
    }
    if (stopping || child_finished <= 0) return 0;
    if (WIFEXITED(child_status)) return WEXITSTATUS(child_status);
    if (WIFSIGNALED(child_status)) return 128 + WTERMSIG(child_status);
    return 0;
}
