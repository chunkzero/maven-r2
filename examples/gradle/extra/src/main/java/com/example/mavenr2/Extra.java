package com.example.mavenr2;

/** Demonstrates publishing a dependency between modules. */
public final class Extra {
    private Extra() {}

    /** @return the core greeting */
    public static String message() {
        return Greeting.message();
    }
}
